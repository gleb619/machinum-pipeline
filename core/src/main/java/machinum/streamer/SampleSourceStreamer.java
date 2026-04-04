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
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import lombok.extern.slf4j.Slf4j;
import machinum.compiler.CommonCompiler;
import machinum.definition.PipelineDefinition.SourceDefinition;
import org.yaml.snakeyaml.Yaml;

@Slf4j
public final class SampleSourceStreamer implements Streamer {

  private static final int DEFAULT_BATCH_SIZE = 10;
  private static final String SAMPLE_CLASSPATH_DIR = "/sample";
  private static final Pattern CHAPTER_PATTERN =
      Pattern.compile("^ch(\\d+)\\.md$", Pattern.CASE_INSENSITIVE);
  private static final int MAX_CHAPTER_SCAN = 200;

  private final SourceDefinition source;
  private final int batchSize;
  private final Path testSampleDir;

  public SampleSourceStreamer(SourceDefinition source) {
    this(source, DEFAULT_BATCH_SIZE);
  }

  public SampleSourceStreamer(SourceDefinition source, int batchSize) {
    this(source, null, batchSize);
  }

  SampleSourceStreamer(SourceDefinition source, Path testSampleDir, int batchSize) {
    this.source = source;
    this.batchSize = batchSize;
    this.testSampleDir = testSampleDir;
  }

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
      List<ChapterResource> chapters = collectChapters();

      detectMissingChapters(chapters, cur, errorHandler);

      List<StreamItem> batch = new ArrayList<>();
      int index = 0;

      for (ChapterResource chapter : chapters) {
        if (index < offset) {
          index++;
          continue;
        }

        try {
          String fullContent = chapter.readContent();
          ChapterParseResult parseResult = parseChapterHeader(fullContent);

          Integer chapterNumber = extractChapterNumber(chapter.fileName());
          if (chapterNumber == null) {
            log.warn("Skipping file with invalid chapter format: {}", chapter.fileName());
            continue;
          }

          StreamItem item = StreamItem.builder()
              .file(Optional.ofNullable(chapter.path()))
              .index(index)
              .content(parseResult.bodyContent())
              .meta("chapterNumber", chapterNumber)
              .meta("fileName", chapter.fileName())
              .meta("title", parseResult.header() != null ? parseResult.header().title() : null)
              .meta(
                  "wordCount",
                  parseResult.header() != null ? parseResult.header().wordCount() : null)
              .meta(
                  "ageRating",
                  parseResult.header() != null ? parseResult.header().ageRating() : null)
              .meta(
                  "contentWarnings",
                  parseResult.header() != null ? parseResult.header().contentWarnings() : List.of())
              .meta(
                  "defects",
                  parseResult.header() != null ? parseResult.header().defects() : List.of())
              .meta("hasHeader", parseResult.header() != null)
              .meta("format", "md")
              .meta("type", "chapter")
              .meta(
                  "timeout",
                  parseResult.header() != null ? parseResult.header().timeout() : Duration.ZERO)
              .build();

          Duration timeout =
              parseResult.header() != null ? parseResult.header().timeout() : Duration.ZERO;
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
          errorHandler.accept(
              StreamError.io("Failed to read chapter: " + chapter.fileName(), e, cur));
        }
      }

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

  private List<ChapterResource> collectChapters() throws IOException {
    if (testSampleDir != null) {
      return collectFromFilesystem(testSampleDir);
    }
    return collectFromClasspath();
  }

  private List<ChapterResource> collectFromClasspath() throws IOException {
    List<ChapterResource> chapters = new ArrayList<>();

    for (int i = 1; i <= MAX_CHAPTER_SCAN; i++) {
      String resourceName = SAMPLE_CLASSPATH_DIR + "/ch" + i + ".md";
      InputStream is = getClass().getResourceAsStream(resourceName);
      if (is != null) {
        String content;
        try (BufferedReader reader =
            new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
          content = reader.lines().collect(Collectors.joining("\n"));
        }
        chapters.add(new ChapterResource(Path.of(resourceName), "ch%d.md".formatted(i), content));
      }
    }

    chapters.sort(this::compareChapterResources);
    return chapters;
  }

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
            chapters.add(new ChapterResource(entry, fileName, null));
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

  private void detectMissingChapters(
      List<ChapterResource> chapters, StreamCursor cursor, Consumer<StreamError> errorHandler) {
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
          missingChapters, maxChapter, foundChapters);

      log.warn(message);
      errorHandler.accept(StreamError.parse(message, null, cursor));
    }
  }

  private ChapterParseResult parseChapterHeader(String fullContent) {
    int firstMarker = fullContent.indexOf("---");
    if (firstMarker == -1 || firstMarker > 50) {
      return new ChapterParseResult(null, fullContent.trim());
    }

    int secondMarker = fullContent.indexOf("---", firstMarker + 3);
    if (secondMarker == -1) {
      return new ChapterParseResult(null, fullContent.trim());
    }

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
      String timeout = Objects.toString(map.get("timeout"), null);
      var duration = CommonCompiler.INSTANCE.compileDuration(timeout);
      return new ChapterHeader(
          getString(map, "title"),
          getInteger(map, "word_count"),
          getString(map, "age_rating"),
          getList(map, "content_warnings"),
          getList(map, "defects"),
          duration.get());
    }

    @SuppressWarnings("unchecked")
    private static List<String> getList(Map<String, Object> map, String key) {
      Object value = map.get(key);
      if (value instanceof List) {
        return ((List<Object>) value).stream().map(Object::toString).toList();
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
  }
}
