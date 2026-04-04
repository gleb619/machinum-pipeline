package machinum.streamer;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import lombok.extern.slf4j.Slf4j;
import machinum.definition.PipelineDefinition.SourceDefinition;
import org.yaml.snakeyaml.Yaml;

/**
 * Streams sample chapter files from classpath resources ({@code /sample/}).
 * <p>
 * Reads deliberately defective sample chapters used for testing book-processing pipelines.
 * Each chapter contains YAML frontmatter metadata followed by markdown body content.
 * <p>
 * <b>URI format:</b> {@code samples://default}
 * <p>
 * <b>Timeout Support:</b> Chapters may include a {@code timeout} field in their YAML header
 * (e.g., {@code timeout: 3s}). When present, the streamer simulates a deadline by sleeping
 * for the specified duration before emitting the item. This enables testing pipeline deadline
 * handling. Default value is {@code Duration.ZERO} (no wait).
 *
 * @see <a href="yaml-schema.md#41-source-uri-schema">YAML Schema §4.1 — Source URI</a>
 * @see <a href="technical-design.md#34-stream-lifecycle-management">Technical Design §3.4 — Stream Lifecycle</a>
 * @see <a href="core-architecture.md#1-base-models-mvp">Core Architecture §1 — Base Models</a>
 * @see <a href="create-sample-streamer-task.md">Sample SourceStreamer Task</a>
 */
@Slf4j
public final class SampleSourceStreamer implements Streamer {

  private static final int DEFAULT_BATCH_SIZE = 10;
  private static final String SAMPLE_CLASSPATH_DIR = "/sample";
  private static final Pattern CHAPTER_PATTERN = Pattern.compile("^ch(\\d+)\\.md$", Pattern.CASE_INSENSITIVE);
  private static final int MAX_CHAPTER_SCAN = 200;

  private final SourceDefinition source;
  private final int batchSize;
  // Nullable — when set, reads from filesystem instead of classpath (test-only)
  private final Path testSampleDir;

  /** Production constructor — reads from classpath resources. */
  public SampleSourceStreamer(SourceDefinition source) {
    this(source, DEFAULT_BATCH_SIZE);
  }

  /** Production constructor with custom batch size — reads from classpath resources. */
  public SampleSourceStreamer(SourceDefinition source, int batchSize) {
    this(source, null, batchSize);
  }

  /**
   * Test-only constructor — reads sample files from a filesystem directory.
   *
   * @param source     source definition (URI used for metadata only)
   * @param testSampleDir directory containing ch*.md files
   * @param batchSize  batch size for streaming
   */
  SampleSourceStreamer(SourceDefinition source, Path testSampleDir, int batchSize) {
    this.source = source;
    this.batchSize = batchSize;
    this.testSampleDir = testSampleDir;
  }

  /** Convenience test constructor with default batch size. */
  SampleSourceStreamer(SourceDefinition source, Path testSampleDir) {
    this(source, testSampleDir, DEFAULT_BATCH_SIZE);
  }

  @Override
  public void stream(Path workspaceDir, StreamCursor cursor, StreamerCallback callback) {
    stream(
        workspaceDir,
        cursor,
        callback,
        error -> log.error(
            "Stream error at cursor {}: {}",
            error.cursorAtError(),
            error.message(),
            error.cause()));
  }

  @Override
  public void stream(
      Path workspaceDir,
      StreamCursor cursor,
      StreamerCallback callback,
      Consumer<StreamError> errorHandler) {

    StreamCursor cur = cursor != null ? cursor : StreamCursor.initial();
    int offset = cur.itemOffset();

    callback.onStreamStart(cur);

    try {
      // Collect and sort chapter resources (classpath or filesystem)
      List<ChapterResource> chapters = collectChapters();

      // Detect missing chapters and emit error if needed
      detectMissingChapters(chapters, cur, errorHandler);

      // Stream chapters
      List<StreamItem> batch = new ArrayList<>();
      int index = 0;

      for (ChapterResource chapter : chapters) {
        if (index < offset) {
          index++;
          continue;
        }

        try {
          // Read content and parse header
          String fullContent = chapter.readContent();
          ChapterParseResult parseResult = parseChapterHeader(fullContent);

          // Extract chapter number from filename
          Integer chapterNumber = extractChapterNumber(chapter.fileName());
          if (chapterNumber == null) {
            log.warn("Skipping file with invalid chapter format: {}", chapter.fileName());
            continue;
          }

          // Build StreamItem with body-only content
          StreamItem item = StreamItem.builder()
              .file(chapter.path())
              .index(index)
              .content(parseResult.bodyContent())
              .meta("chapterNumber", chapterNumber)
              .meta("fileName", chapter.fileName())
              .meta("title", parseResult.header() != null ? parseResult.header().title() : null)
              .meta("wordCount", parseResult.header() != null ? parseResult.header().wordCount() : null)
              .meta("ageRating", parseResult.header() != null ? parseResult.header().ageRating() : null)
              .meta("contentWarnings", parseResult.header() != null ? parseResult.header().contentWarnings() : List.of())
              .meta("defects", parseResult.header() != null ? parseResult.header().defects() : List.of())
              .meta("hasHeader", parseResult.header() != null)
              .meta("format", "md")
              .meta("type", "chapter")
              .meta("timeout", parseResult.header() != null ? parseResult.header().timeout() : Duration.ZERO)
              .build();

          // Apply timeout simulation if configured
          Duration timeout = parseResult.header() != null ? parseResult.header().timeout() : Duration.ZERO;
          if (!timeout.isZero() && !timeout.isNegative()) {
            log.debug("Simulating timeout of {} for chapter {}", timeout, chapter.fileName());
            try {
              Thread.sleep(timeout.toMillis());
            } catch (InterruptedException ie) {
              Thread.currentThread().interrupt();
              throw new IOException("Stream interrupted during timeout simulation", ie);
            }
          }

          batch.add(item);
          index++;

          if (batch.size() >= batchSize) {
            cur = cur.advance(batch.size());
            if (!callback.onBatch(List.copyOf(batch), cur)) {
              return;
            }
            batch.clear();
          }
        } catch (IOException e) {
          errorHandler.accept(StreamError.io("Failed to read chapter: " + chapter.fileName(), e, cur));
        }
      }

      // Flush remaining batch
      if (!batch.isEmpty()) {
        cur = cur.advance(batch.size());
        callback.onBatch(List.copyOf(batch), cur);
      }

      callback.onStreamEnd(cur);

    } catch (IOException e) {
      errorHandler.accept(StreamError.io("Failed to process sample resources", e, cur));
      callback.onStreamEnd(cur);
    }
  }

  /**
   * Collects chapter resources from classpath or filesystem (test mode).
   * Files are sorted by natural numeric chapter order.
   */
  private List<ChapterResource> collectChapters() throws IOException {
    if (testSampleDir != null) {
      return collectFromFilesystem(testSampleDir);
    }
    return collectFromClasspath();
  }

  /** Scans classpath /sample/ for ch*.md resources. */
  private List<ChapterResource> collectFromClasspath() throws IOException {
    List<ChapterResource> chapters = new ArrayList<>();

    for (int i = 1; i <= MAX_CHAPTER_SCAN; i++) {
      String resourceName = SAMPLE_CLASSPATH_DIR + "/ch" + i + ".md";
      InputStream is = getClass().getResourceAsStream(resourceName);
      if (is != null) {
        // Read content eagerly and store as string, so stream can be closed
        String content;
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(is, StandardCharsets.UTF_8))) {
          content = reader.lines().collect(Collectors.joining("\n"));
        }
        chapters.add(new ChapterResource(
            Path.of(resourceName),
            "ch" + i + ".md",
            content));
      }
    }

    chapters.sort(this::compareChapterResources);
    return chapters;
  }

  /** Scans a filesystem directory for ch*.md files (test mode). */
  private List<ChapterResource> collectFromFilesystem(Path sampleDir) throws IOException {
    List<ChapterResource> chapters = new ArrayList<>();

    if (!Files.exists(sampleDir)) {
      return chapters;
    }

    try (DirectoryStream<Path> stream = Files.newDirectoryStream(sampleDir)) {
      for (Path entry : stream) {
        if (Files.isRegularFile(entry)) {
          String fileName = entry.getFileName().toString();
          if (CHAPTER_PATTERN.matcher(fileName).matches()) {
            chapters.add(new ChapterResource(
                entry,
                fileName,
                null /* read from filesystem */));
          }
        }
      }
    }

    chapters.sort(this::compareChapterResources);
    return chapters;
  }

  private int compareChapterResources(ChapterResource a, ChapterResource b) {
    Integer numA = extractChapterNumber(a.fileName());
    Integer numB = extractChapterNumber(b.fileName());

    if (numA == null && numB == null) return 0;
    if (numA == null) return 1;
    if (numB == null) return -1;

    return Integer.compare(numA, numB);
  }

  private Integer extractChapterNumber(String fileName) {
    Matcher matcher = CHAPTER_PATTERN.matcher(fileName);
    if (matcher.matches()) {
      try {
        return Integer.parseInt(matcher.group(1));
      } catch (NumberFormatException e) {
        return null;
      }
    }
    return null;
  }

  private void detectMissingChapters(List<ChapterResource> chapters, StreamCursor cursor, Consumer<StreamError> errorHandler) {
    Set<Integer> foundChapters = new TreeSet<>();
    for (ChapterResource ch : chapters) {
      Integer chapterNum = extractChapterNumber(ch.fileName());
      if (chapterNum != null) {
        foundChapters.add(chapterNum);
      }
    }

    if (foundChapters.isEmpty()) {
      return;
    }

    int maxChapter = foundChapters.stream().mapToInt(Integer::intValue).max().orElse(0);
    List<Integer> missingChapters = new ArrayList<>();

    for (int i = 1; i <= maxChapter; i++) {
      if (!foundChapters.contains(i)) {
        missingChapters.add(i);
      }
    }

    if (!missingChapters.isEmpty()) {
      String message = String.format(
          "Missing chapter(s): %s. Expected sequence 1-%d, found: %s",
          missingChapters,
          maxChapter,
          foundChapters);

      log.warn(message);
      errorHandler.accept(StreamError.parse(message, null, cursor));
    }
  }

  private ChapterParseResult parseChapterHeader(String fullContent) {
    // Find the first --- (must be at or near line 1)
    int firstMarker = fullContent.indexOf("---");
    if (firstMarker == -1 || firstMarker > 50) { // Allow some whitespace at start
      return new ChapterParseResult(null, fullContent.trim());
    }

    // Find the closing --- (second occurrence)
    int secondMarker = fullContent.indexOf("---", firstMarker + 3);
    if (secondMarker == -1) {
      return new ChapterParseResult(null, fullContent.trim());
    }

    // Extract YAML block between the markers
    String yamlBlock = fullContent.substring(firstMarker + 3, secondMarker).trim();
    String bodyContent = fullContent.substring(secondMarker + 3).trim();

    try {
      Yaml yaml = new Yaml();
      Map<String, Object> yamlData = yaml.load(yamlBlock);

      if (yamlData == null) {
        return new ChapterParseResult(null, bodyContent);
      }

      ChapterHeader header = ChapterHeader.fromMap(yamlData);
      return new ChapterParseResult(header, bodyContent);

    } catch (Exception e) {
      log.debug("Failed to parse YAML header, treating as body content", e);
      return new ChapterParseResult(null, fullContent.trim());
    }
  }

  /** Represents a chapter resource, either from classpath (pre-loaded string) or filesystem. */
  private record ChapterResource(Path path, String fileName, String classpathContent) {

    String readContent() throws IOException {
      if (classpathContent != null) {
        return classpathContent;
      }
      return Files.readString(path);
    }
  }

  private record ChapterParseResult(ChapterHeader header, String bodyContent) {}

  private record ChapterHeader(
      String title,
      Integer wordCount,
      String ageRating,
      List<String> contentWarnings,
      List<String> defects,
      Duration timeout) {

    static ChapterHeader fromMap(Map<String, Object> map) {
      return new ChapterHeader(
          getString(map, "title"),
          getInteger(map, "word_count"),
          getString(map, "age_rating"),
          getList(map, "content_warnings"),
          getList(map, "defects"),
          getDuration(map, "timeout")
      );
    }

    @SuppressWarnings("unchecked")
    private static List<String> getList(Map<String, Object> map, String key) {
      Object value = map.get(key);
      if (value instanceof List) {
        return ((List<Object>) value).stream()
            .map(Object::toString)
            .toList();
      }
      return List.of();
    }

    private static String getString(Map<String, Object> map, String key) {
      Object value = map.get(key);
      return value != null ? value.toString() : null;
    }

    private static Integer getInteger(Map<String, Object> map, String key) {
      Object value = map.get(key);
      if (value instanceof Number) {
        return ((Number) value).intValue();
      }
      if (value instanceof String) {
        try {
          return Integer.parseInt((String) value);
        } catch (NumberFormatException e) {
          return null;
        }
      }
      return null;
    }

    private static Duration getDuration(Map<String, Object> map, String key) {
      Object value = map.get(key);
      if (value == null) return Duration.ZERO;
      if (value instanceof Duration) return (Duration) value;
      String str = value.toString().trim();
      if (str.isEmpty()) return Duration.ZERO;
      // Parse simple duration formats: "3s", "500ms", "1m", "2m30s"
      if (str.matches("^\\d+$")) {
        // Plain number treated as seconds
        return Duration.ofSeconds(Long.parseLong(str));
      }
      if (str.matches("^\\d+ms$")) {
        return Duration.ofMillis(Long.parseLong(str.replace("ms", "")));
      }
      if (str.matches("^\\d+s$")) {
        return Duration.ofSeconds(Long.parseLong(str.replace("s", "")));
      }
      if (str.matches("^\\d+m$")) {
        return Duration.ofMinutes(Long.parseLong(str.replace("m", "")));
      }
      if (str.matches("^\\d+m\\d+s$")) {
        String[] parts = str.split("[ms]");
        return Duration.ofMinutes(Long.parseLong(parts[0]))
            .plusSeconds(Long.parseLong(parts[1]));
      }
      log.warn("Unrecognized timeout format: '{}', defaulting to ZERO", str);
      return Duration.ZERO;
    }
  }
}
