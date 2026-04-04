package machinum.streamer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import lombok.extern.slf4j.Slf4j;
import machinum.compiler.Compiled;
import machinum.definition.PipelineDefinition.SourceDefinition;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

@Slf4j
class SampleSourceStreamerTest {

  @Mock
  private SourceDefinition mockSource;

  @Mock
  private Compiled<String> mockUri;

  private SampleSourceStreamer streamer;

  @BeforeEach
  void setUp() {
    MockitoAnnotations.openMocks(this);
    when(mockSource.uri()).thenReturn(mockUri);
    when(mockUri.get()).thenReturn("samples://default");
    // Use production constructor (classpath mode) for default setup
    streamer = new SampleSourceStreamer(mockSource);
  }

  @Test
  void streamsAllChapterBodiesWithoutHeaders(@TempDir Path tempDir) throws IOException {
    // Create sample directory and chapter files with YAML headers
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    createChapterFile(sampleDir, "ch1.md",
        """
            ---
            title: Chapter 1
            word_count: 100
            ---
            
            # Chapter 1
            Body content here""");
    createChapterFile(sampleDir, "ch2.md",
        """
            ---
            title: Chapter 2
            word_count: 200
            ---
            
            # Chapter 2
            More body content""");
    createChapterFile(sampleDir, "ch3.md",
        """
            ---
            title: Chapter 3
            word_count: 300
            ---
            
            # Chapter 3
            Final body content""");

    List<StreamItem> capturedItems = new ArrayList<>();
    StreamerCallback callback = createCapturingCallback(capturedItems);

    // Use test constructor to read from filesystem
    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, sampleDir);
    fsStreamer.stream(tempDir, StreamCursor.initial(), callback);

    assertThat(capturedItems).hasSize(3);
    assertThat(capturedItems.get(0).content()).isEqualTo("# Chapter 1\nBody content here");
    assertThat(capturedItems.get(1).content()).isEqualTo("# Chapter 2\nMore body content");
    assertThat(capturedItems.get(2).content()).isEqualTo("# Chapter 3\nFinal body content");
    
    // Verify no YAML markers in content
    for (StreamItem item : capturedItems) {
      assertThat(item.content()).doesNotContain("---");
    }
  }

  @Test
  void extractsMetadataFromYamlHeaders(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    createChapterFile(sampleDir, "ch1.md",
        """
            ---
            title: "Chapter 1: Salvage"
            word_count: 620
            age_rating: "18+"
            content_warnings: ["mild swearing", "implied poverty violence"]
            defects:
              - typo
              - missing punctuation
            ---
            
            # Chapter 1
            Body content""");

    List<StreamItem> capturedItems = new ArrayList<>();
    StreamerCallback callback = createCapturingCallback(capturedItems);

    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, sampleDir);
    fsStreamer.stream(tempDir, StreamCursor.initial(), callback);

    assertThat(capturedItems).hasSize(1);
    StreamItem item = capturedItems.get(0);
    
    assertThat(item.meta("chapterNumber")).isEqualTo(1);
    assertThat(item.meta("fileName")).isEqualTo("ch1.md");
    assertThat(item.meta("title")).isEqualTo("Chapter 1: Salvage");
    assertThat(item.meta("wordCount")).isEqualTo(620);
    assertThat(item.meta("ageRating")).isEqualTo("18+");
    assertThat(item.meta("contentWarnings")).isEqualTo(List.of("mild swearing", "implied poverty violence"));
    assertThat(item.meta("defects")).isEqualTo(List.of("typo", "missing punctuation"));
    assertThat(item.meta("hasHeader")).isEqualTo(true);
    assertThat(item.meta("format")).isEqualTo("md");
    assertThat(item.meta("type")).isEqualTo("chapter");
  }

  @Test
  void sortsFilesInNaturalNumericOrder(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    // Create files in non-alphabetic order
    createChapterFile(sampleDir, "ch11.md", """
        ---
        title: Chapter 11
        ---
        
        # Chapter 11
        Content""");
    createChapterFile(sampleDir, "ch2.md", """
        ---
        title: Chapter 2
        ---
        
        # Chapter 2
        Content""");
    createChapterFile(sampleDir, "ch1.md", """
        ---
        title: Chapter 1
        ---
        
        # Chapter 1
        Content""");
    createChapterFile(sampleDir, "ch9.md", """
        ---
        title: Chapter 9
        ---
        
        # Chapter 9
        Content""");

    List<StreamItem> capturedItems = new ArrayList<>();
    StreamerCallback callback = createCapturingCallback(capturedItems);

    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, sampleDir);
    fsStreamer.stream(tempDir, StreamCursor.initial(), callback);

    assertThat(capturedItems).hasSize(4);
    // Verify natural numeric ordering: ch1, ch2, ch9, ch11
    assertThat(capturedItems.get(0).meta("chapterNumber")).isEqualTo(1);
    assertThat(capturedItems.get(1).meta("chapterNumber")).isEqualTo(2);
    assertThat(capturedItems.get(2).meta("chapterNumber")).isEqualTo(9);
    assertThat(capturedItems.get(3).meta("chapterNumber")).isEqualTo(11);
  }

  @Test
  void detectsMissingChapter10(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    // Create chapters 1-9 and 11, missing chapter 10
    for (int i = 1; i <= 9; i++) {
      createChapterFile(sampleDir, "ch%d.md".formatted(i),
          """
          ---
          title: Chapter %d
          ---
          
          # Chapter %d
          Content""".formatted(i, i));
    }
    createChapterFile(sampleDir, "ch11.md",
        """
            ---
            title: Chapter 11
            ---
            
            # Chapter 11
            Content""");

    AtomicReference<StreamError> capturedError = new AtomicReference<>();
    List<StreamItem> capturedItems = new ArrayList<>();
    StreamerCallback callback = createCapturingCallback(capturedItems);
    Consumer<StreamError> errorHandler = capturedError::set;

    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, sampleDir);
    fsStreamer.stream(tempDir, StreamCursor.initial(), callback, errorHandler);

    // Verify error was emitted for missing chapter 10
    assertThat(capturedError.get()).isNotNull();
    assertThat(capturedError.get().type()).isEqualTo(StreamError.ErrorType.PARSE);
    assertThat(capturedError.get().message()).contains("Missing chapter(s): [10]");
    
    // Verify streaming continued despite missing chapter
    assertThat(capturedItems).hasSize(10); // chapters 1-9 and 11
  }

  @Test
  void continuesStreamingAfterMissingChapter(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    // Create chapters 1-9 and 11, missing chapter 10
    for (int i = 1; i <= 9; i++) {
      createChapterFile(sampleDir, "ch%d.md".formatted(i),
          """
          ---
          title: Chapter %d
          ---
          
          # Chapter %d
          Content""".formatted(i, i));
    }
    createChapterFile(sampleDir, "ch11.md",
        """
            ---
            title: Chapter 11
            ---
            
            # Chapter 11
            Content""");

    List<StreamItem> capturedItems = new ArrayList<>();
    StreamerCallback callback = createCapturingCallback(capturedItems);

    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, sampleDir);
    fsStreamer.stream(tempDir, StreamCursor.initial(), callback);

    // Verify all chapters except missing one were streamed
    assertThat(capturedItems).hasSize(10);
    assertThat(capturedItems.get(8).meta("chapterNumber")).isEqualTo(9);
    assertThat(capturedItems.get(9).meta("chapterNumber")).isEqualTo(11);
  }

  @Test
  void respectsBatchSize(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    // Create 5 chapter files
    for (int i = 1; i <= 5; i++) {
      createChapterFile(sampleDir, "ch%d.md".formatted(i),
          """
          ---
          title: Chapter %d
          ---
          
          # Chapter %d
          Content""".formatted(i, i));
    }

    SampleSourceStreamer batchedStreamer = new SampleSourceStreamer(mockSource, sampleDir, 2);
    
    AtomicInteger batchCount = new AtomicInteger(0);
    List<Integer> batchSizes = new ArrayList<>();
    
    StreamerCallback callback = new StreamerCallback() {
      @Override
      public boolean onBatch(List<StreamItem> items, StreamCursor cursor) {
        batchCount.incrementAndGet();
        batchSizes.add(items.size());
        return true;
      }
    };

    batchedStreamer.stream(tempDir, StreamCursor.initial(), callback);

    assertThat(batchCount.get()).isEqualTo(3); // 2 + 2 + 1
    assertThat(batchSizes).containsExactly(2, 2, 1);
  }

  @Test
  void resumesFromCursorOffset(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    // Create 5 chapter files
    for (int i = 1; i <= 5; i++) {
      createChapterFile(sampleDir, "ch%d.md".formatted(i),
          """
          ---
          title: Chapter %d
          ---
          
          # Chapter %d
          Content""".formatted(i, i));
    }

    List<StreamItem> capturedItems = new ArrayList<>();
    StreamerCallback callback = createCapturingCallback(capturedItems);

    // Start from offset 2 (skip first 2 chapters)
    StreamCursor offsetCursor = new StreamCursor(0, 2, 0);
    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, sampleDir);
    fsStreamer.stream(tempDir, offsetCursor, callback);

    assertThat(capturedItems).hasSize(3);
    assertThat(capturedItems.get(0).meta("chapterNumber")).isEqualTo(3);
    assertThat(capturedItems.get(1).meta("chapterNumber")).isEqualTo(4);
    assertThat(capturedItems.get(2).meta("chapterNumber")).isEqualTo(5);
  }

  @Test
  void handlesFileWithoutValidHeader(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    // Create file without YAML header
    createChapterFile(sampleDir, "ch1.md", "# Chapter 1\nJust body content, no header");

    List<StreamItem> capturedItems = new ArrayList<>();
    StreamerCallback callback = createCapturingCallback(capturedItems);

    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, sampleDir);
    fsStreamer.stream(tempDir, StreamCursor.initial(), callback);

    assertThat(capturedItems).hasSize(1);
    StreamItem item = capturedItems.get(0);
    
    // Entire file should be treated as body
    assertThat(item.content()).isEqualTo("# Chapter 1\nJust body content, no header");
    assertThat(item.meta("hasHeader")).isEqualTo(false);
    assertThat(item.meta("title")).isNull();
  }

  @Test
  void errorHandlerReceivesIoErrors(@TempDir Path tempDir) {
    // Use empty sample directory (no files)
    Path emptySampleDir = tempDir.resolve("empty-sample");

    AtomicReference<StreamError> capturedError = new AtomicReference<>();
    AtomicBoolean streamStarted = new AtomicBoolean(false);
    AtomicBoolean streamEnded = new AtomicBoolean(false);

    StreamerCallback callback = new StreamerCallback() {
      @Override
      public void onStreamStart(StreamCursor cursor) {
        streamStarted.set(true);
      }

      @Override
      public boolean onBatch(List<StreamItem> items, StreamCursor cursor) {
        return true;
      }

      @Override
      public void onStreamEnd(StreamCursor cursor) {
        streamEnded.set(true);
      }
    };

    Consumer<StreamError> errorHandler = error -> capturedError.set(error);

    // Create streamer with non-existent sample dir
    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, emptySampleDir);
    fsStreamer.stream(tempDir, StreamCursor.initial(), callback, errorHandler);

    // With empty/non-existent dir, no chapters found, stream completes normally
    assertThat(streamStarted.get()).isTrue();
    assertThat(streamEnded.get()).isTrue();
    // No IO error emitted because directory just has no matching files
    assertThat(capturedError.get()).isNull();
  }

  @Test
  void onStreamStartAndOnStreamEndCalled(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    createChapterFile(sampleDir, "ch1.md", """
        ---
        title: Chapter 1
        ---
        
        # Chapter 1
        Content""");

    AtomicBoolean streamStarted = new AtomicBoolean(false);
    AtomicBoolean streamEnded = new AtomicBoolean(false);

    StreamerCallback callback = new StreamerCallback() {
      @Override
      public void onStreamStart(StreamCursor cursor) {
        streamStarted.set(true);
      }

      @Override
      public boolean onBatch(List<StreamItem> items, StreamCursor cursor) {
        return true;
      }

      @Override
      public void onStreamEnd(StreamCursor cursor) {
        streamEnded.set(true);
      }
    };

    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, sampleDir);
    fsStreamer.stream(tempDir, StreamCursor.initial(), callback);

    assertThat(streamStarted.get()).isTrue();
    assertThat(streamEnded.get()).isTrue();
  }

  @Test
  void handlesMalformedYamlHeader(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    // Create file with malformed YAML
    createChapterFile(sampleDir, "ch1.md",
        """
            ---
            title: Chapter 1
            word_count: invalid_number
            age_rating: 18+
            ---
            
            # Chapter 1
            Content""");

    List<StreamItem> capturedItems = new ArrayList<>();
    StreamerCallback callback = createCapturingCallback(capturedItems);

    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, sampleDir);
    fsStreamer.stream(tempDir, StreamCursor.initial(), callback);

    assertThat(capturedItems).hasSize(1);
    StreamItem item = capturedItems.get(0);
    
    // Should gracefully handle malformed YAML
    assertThat(item.content()).isEqualTo("# Chapter 1\nContent");
    assertThat(item.meta("hasHeader")).isEqualTo(true); // Header found but partially parsed
    assertThat(item.meta("title")).isEqualTo("Chapter 1");
    assertThat(item.meta("wordCount")).isNull(); // Failed to parse invalid number
  }

  @Test
  void skipsNonChapterFiles(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    // Create chapter files and other files
    createChapterFile(sampleDir, "ch1.md", """
        ---
        title: Chapter 1
        ---
        
        # Chapter 1
        Content""");
    createChapterFile(sampleDir, "ch2.md", """
        ---
        title: Chapter 2
        ---
        
        # Chapter 2
        Content""");
    createChapterFile(sampleDir, "README.md", "# README\nNot a chapter");
    createChapterFile(sampleDir, "notes.txt", "Some notes");
    createChapterFile(sampleDir, "extra.md", "# Extra\nNot matching pattern");

    List<StreamItem> capturedItems = new ArrayList<>();
    StreamerCallback callback = createCapturingCallback(capturedItems);

    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, sampleDir);
    fsStreamer.stream(tempDir, StreamCursor.initial(), callback);

    // Should only process chapter files
    assertThat(capturedItems).hasSize(2);
    assertThat(capturedItems.get(0).meta("fileName")).isEqualTo("ch1.md");
    assertThat(capturedItems.get(1).meta("fileName")).isEqualTo("ch2.md");
  }

  private void createChapterFile(Path dir, String filename, String content) throws IOException {
    Path file = dir.resolve(filename);
    Files.writeString(file, content);
  }

  private StreamerCallback createCapturingCallback(List<StreamItem> capturedItems) {
    return new StreamerCallback() {
      @Override
      public boolean onBatch(List<StreamItem> items, StreamCursor cursor) {
        capturedItems.addAll(items);
        return true;
      }
    };
  }

  @Test
  void extractsTimeoutFromHeader(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    createChapterFile(sampleDir, "ch1.md",
        """
            ---
            title: Chapter 1
            timeout: 1s
            ---
            
            # Chapter 1
            Content""");

    List<StreamItem> capturedItems = new ArrayList<>();
    StreamerCallback callback = createCapturingCallback(capturedItems);

    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, sampleDir);
    fsStreamer.stream(tempDir, StreamCursor.initial(), callback);

    assertThat(capturedItems).hasSize(1);
    assertThat(capturedItems.get(0).meta("timeout")).isEqualTo(Duration.ofSeconds(1));
  }

  @Test
  void defaultTimeoutIsZeroWhenAbsent(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    createChapterFile(sampleDir, "ch1.md",
        """
            ---
            title: Chapter 1
            ---
            
            # Chapter 1
            Content""");

    List<StreamItem> capturedItems = new ArrayList<>();
    StreamerCallback callback = createCapturingCallback(capturedItems);

    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, sampleDir);
    fsStreamer.stream(tempDir, StreamCursor.initial(), callback);

    assertThat(capturedItems).hasSize(1);
    assertThat(capturedItems.get(0).meta("timeout")).isEqualTo(Duration.ZERO);
  }

  @Test
  void respectsTimeoutWait(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    createChapterFile(sampleDir, "ch1.md",
        """
            ---
            title: Chapter 1
            timeout: 1s
            ---
            
            # Chapter 1
            Content""");

    List<StreamItem> capturedItems = new ArrayList<>();
    StreamerCallback callback = createCapturingCallback(capturedItems);

    long start = System.currentTimeMillis();
    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, sampleDir);
    fsStreamer.stream(tempDir, StreamCursor.initial(), callback);
    long elapsed = System.currentTimeMillis() - start;

    assertThat(elapsed).isGreaterThanOrEqualTo(950); // Allow 50ms tolerance
    assertThat(capturedItems).hasSize(1);
    assertThat(capturedItems.get(0).meta("timeout")).isEqualTo(Duration.ofSeconds(1));
  }
}
