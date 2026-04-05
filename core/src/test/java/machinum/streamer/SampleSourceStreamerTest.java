package machinum.streamer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import lombok.extern.slf4j.Slf4j;
import machinum.checkpoint.CheckpointStore;
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
  private CheckpointStore mockCheckpointStore;

  @Mock
  private Compiled<String> mockUri;

  @BeforeEach
  void setUp() {
    MockitoAnnotations.openMocks(this);
    when(mockSource.uri()).thenReturn(mockUri);
    when(mockUri.get()).thenReturn("samples://default");
  }

  @Test
  void streamsAllChapterBodiesWithoutHeaders(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    createChapterFile(sampleDir, "ch1.md", """
            ---
            title: Chapter 1
            word_count: 100
            ---

            # Chapter 1
            Body content here""");
    createChapterFile(sampleDir, "ch2.md", """
            ---
            title: Chapter 2
            word_count: 200
            ---

            # Chapter 2
            More body content""");

    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, mockCheckpointStore, sampleDir, 10);
    try (StreamResult result = fsStreamer.stream(tempDir, "test-run")) {
      List<StreamItem> items = consume(result);
      assertThat(items).hasSize(2);
      assertThat(items.get(0).content()).isEqualTo("# Chapter 1\nBody content here");
      assertThat(items.get(1).content()).isEqualTo("# Chapter 2\nMore body content");
    }
  }

  @Test
  void extractsMetadataFromYamlHeaders(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    createChapterFile(sampleDir, "ch1.md", """
            ---
            title: "Chapter 1: Salvage"
            word_count: 620
            age_rating: "18+"
            content_warnings: ["mild swearing"]
            ---

            # Chapter 1
            Body content""");

    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, mockCheckpointStore, sampleDir, 10);
    try (StreamResult result = fsStreamer.stream(tempDir, "test-run")) {
      List<StreamItem> items = consume(result);
      assertThat(items).hasSize(1);
      StreamItem item = items.get(0);
      assertThat(item.meta("title")).isEqualTo("Chapter 1: Salvage");
      assertThat(item.meta("wordCount")).isEqualTo(620);
    }
  }

  @Test
  void respectsBatchSize(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    for (int i = 1; i <= 5; i++) {
      createChapterFile(sampleDir, "ch" + i + ".md", "# Content " + i);
    }

    SampleSourceStreamer batchedStreamer = new SampleSourceStreamer(mockSource, mockCheckpointStore, sampleDir, 2);
    try (StreamResult result = batchedStreamer.stream(tempDir, "test-run")) {
      int batchCount = 0;
      int totalItems = 0;
      for (List<StreamItem> batch : result) {
        batchCount++;
        totalItems += batch.size();
      }
      assertThat(batchCount).isEqualTo(3);
      assertThat(totalItems).isEqualTo(5);
    }
  }

  @Test
  void extractsTimeoutFromHeader(@TempDir Path tempDir) throws IOException {
    Path sampleDir = tempDir.resolve("sample");
    Files.createDirectories(sampleDir);
    createChapterFile(sampleDir, "ch1.md", """
            ---
            title: Chapter 1
            timeout: 1s
            ---

            # Chapter 1
            Content""");

    SampleSourceStreamer fsStreamer = new SampleSourceStreamer(mockSource, mockCheckpointStore, sampleDir, 10);
    try (StreamResult result = fsStreamer.stream(tempDir, "test-run")) {
      List<StreamItem> items = consume(result);
      assertThat(items).hasSize(1);
      assertThat(items.getFirst().meta("timeout")).isEqualTo(Duration.ofSeconds(1));
    }
  }

  private void createChapterFile(Path dir, String filename, String content) throws IOException {
    Path file = dir.resolve(filename);
    Files.writeString(file, content);
  }

  private List<StreamItem> consume(StreamResult result) {
    List<StreamItem> items = new ArrayList<>();
    for (List<StreamItem> batch : result) {
      items.addAll(batch);
    }
    return items;
  }
}
