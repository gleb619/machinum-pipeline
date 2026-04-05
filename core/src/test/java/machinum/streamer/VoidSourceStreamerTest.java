package machinum.streamer;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.nio.file.Path;
import java.nio.file.Paths;
import org.junit.jupiter.api.Test;

class VoidSourceStreamerTest {

  private static final Path WORKSPACE_DIR = Paths.get("/tmp/test-workspace");

  @Test
  void voidStreamerCompletesImmediatelyWithNoItems() {
    VoidSourceStreamer streamer = new VoidSourceStreamer();

    try (StreamResult result = streamer.stream(WORKSPACE_DIR, "test-run")) {
      assertNotNull(result, "StreamResult should not be null");
      assertFalse(result.iterator().hasNext(), "Iterator should be empty");
      assertNotNull(result.currentCursor(), "Cursor should not be null");
      assertFalse(result.error().isPresent(), "Error should not be present");
    }
  }

  @Test
  void voidStreamerWorksWithNullRunId() {
    VoidSourceStreamer streamer = new VoidSourceStreamer();

    try (StreamResult result = streamer.stream(WORKSPACE_DIR, null)) {
      assertNotNull(result, "StreamResult should not be null");
      assertFalse(result.iterator().hasNext(), "Iterator should be empty");
    }
  }
}
