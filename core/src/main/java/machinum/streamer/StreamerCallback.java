package machinum.streamer;

import java.util.List;

@FunctionalInterface
public interface StreamerCallback {

  boolean onBatch(List<StreamItem> items, StreamCursor cursor);

  default void onStreamStart(StreamCursor initialCursor) {}

  default void onStreamEnd(StreamCursor finalCursor) {}
}
