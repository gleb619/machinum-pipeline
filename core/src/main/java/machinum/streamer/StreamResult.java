package machinum.streamer;

import java.util.Iterator;
import java.util.List;
import java.util.Optional;

/**
 * Represents the active stream of items.
 * Pull-based and designed to handle sequential data with async consumption via iterators.
 */
public interface StreamResult extends AutoCloseable, Iterable<List<StreamItem>> {

  /**
   * Returns the current cursor of the stream.
   * Updates as items are consumed.
   */
  StreamCursor currentCursor();

  /**
   * Returns an optional non-fatal or fatal error that occurred during streaming.
   */
  Optional<StreamError> error();

  /**
   * Standard iterator for batch-by-batch consumption.
   */
  @Override
  Iterator<List<StreamItem>> iterator();

  @Override
  default void close() {
    // No-op by default
  }
}
