package machinum.streamer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class VoidSourceStreamerTest {

  private static final Path WORKSPACE_DIR = Paths.get("/tmp/test-workspace");

  @Test
  void voidStreamerCompletesImmediatelyWithNoItems() {
    VoidSourceStreamer streamer = new VoidSourceStreamer();
    StreamCursor cursor = StreamCursor.initial();

    AtomicInteger batchCount = new AtomicInteger(0);
    AtomicInteger itemCount = new AtomicInteger(0);
    AtomicBoolean onStartCalled = new AtomicBoolean(false);
    AtomicBoolean onEndCalled = new AtomicBoolean(false);
    List<StreamCursor> startCursors = new ArrayList<>();
    List<StreamCursor> endCursors = new ArrayList<>();

    streamer.stream(WORKSPACE_DIR, cursor, new StreamerCallback() {
      @Override
      public void onStreamStart(StreamCursor initialCursor) {
        onStartCalled.set(true);
        startCursors.add(initialCursor);
      }

      @Override
      public boolean onBatch(List<StreamItem> items, StreamCursor cur) {
        batchCount.incrementAndGet();
        itemCount.addAndGet(items.size());
        return true;
      }

      @Override
      public void onStreamEnd(StreamCursor finalCursor) {
        onEndCalled.set(true);
        endCursors.add(finalCursor);
      }
    });

    assertTrue(onStartCalled.get(), "onStreamStart should be called");
    assertTrue(onEndCalled.get(), "onStreamEnd should be called");
    assertEquals(0, batchCount.get(), "No batches should be emitted");
    assertEquals(0, itemCount.get(), "No items should be emitted");
    assertEquals(1, startCursors.size(), "onStreamStart called once");
    assertEquals(1, endCursors.size(), "onStreamEnd called once");

    StreamCursor startCursor = startCursors.get(0);
    StreamCursor endCursor = endCursors.get(0);
    assertEquals(0, startCursor.itemOffset(), "Start cursor offset should be 0");
    assertEquals(0, endCursor.itemOffset(), "End cursor offset should be 0");
    assertEquals(startCursor.windowId(), endCursor.windowId(), "Window ID should remain the same");
  }

  @Test
  void voidStreamerWorksWithNullCursor() {
    VoidSourceStreamer streamer = new VoidSourceStreamer();

    AtomicBoolean onStartCalled = new AtomicBoolean(false);
    AtomicBoolean onEndCalled = new AtomicBoolean(false);

    streamer.stream(WORKSPACE_DIR, null, new StreamerCallback() {
      @Override
      public void onStreamStart(StreamCursor initialCursor) {
        onStartCalled.set(true);
        assertNotNull(initialCursor, "Cursor should not be null");
        assertEquals(0, initialCursor.windowId(), "Initial cursor window ID should be 0");
      }

      @Override
      public boolean onBatch(List<StreamItem> items, StreamCursor cur) {
        return true;
      }

      @Override
      public void onStreamEnd(StreamCursor finalCursor) {
        onEndCalled.set(true);
        assertNotNull(finalCursor, "Cursor should not be null");
      }
    });

    assertTrue(onStartCalled.get(), "onStreamStart should be called");
    assertTrue(onEndCalled.get(), "onStreamEnd should be called");
  }

  @Test
  void voidStreamerErrorHandlerNeverInvoked() {
    VoidSourceStreamer streamer = new VoidSourceStreamer();
    StreamCursor cursor = StreamCursor.initial();

    AtomicBoolean errorCalled = new AtomicBoolean(false);

    streamer.stream(
        WORKSPACE_DIR,
        cursor,
        new StreamerCallback() {
          @Override
          public boolean onBatch(List<StreamItem> items, StreamCursor cur) {
            return true;
          }
        },
        error -> errorCalled.set(true));

    assertFalse(errorCalled.get(), "Error handler should not be invoked for void streamer");
  }
}
