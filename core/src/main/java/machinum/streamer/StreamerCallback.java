package machinum.streamer;

import java.util.List;

@FunctionalInterface
public interface StreamerCallback {

  /**
   * Called for each batch of stream items.
   *
   * @param items Batch of items to process
   * @param cursor Current stream cursor position
   * @return true to continue streaming, false to stop
   */
  boolean onBatch(List<StreamItem> items, StreamCursor cursor);

  /**
   * Called once when streaming begins.
   *
   * @param initialCursor Initial cursor position
   */
  default void onStreamStart(StreamCursor initialCursor) {}

  /**
   * Called once when streaming completes (either normally or due to stop).
   *
   * @param finalCursor Final cursor position
   */
  default void onStreamEnd(StreamCursor finalCursor) {}
}
