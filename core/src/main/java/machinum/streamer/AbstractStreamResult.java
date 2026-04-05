package machinum.streamer;

import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Base implementation of StreamResult to reduce boilerplate.
 */
public abstract class AbstractStreamResult implements StreamResult {
  protected final AtomicReference<StreamCursor> cursor = new AtomicReference<>(StreamCursor.initial());
  protected final AtomicReference<StreamError> error = new AtomicReference<>();

  @Override
  public StreamCursor currentCursor() {
    return cursor.get();
  }

  @Override
  public Optional<StreamError> error() {
    return Optional.ofNullable(error.get());
  }

  @Override
  public abstract Iterator<List<StreamItem>> iterator();

  /**
   * Helper for empty results.
   */
  public static StreamResult empty() {
    return new AbstractStreamResult() {
      @Override
      public Iterator<List<StreamItem>> iterator() {
        return Collections.emptyIterator();
      }
    };
  }

  /**
   * Updates the current cursor.
   */
  protected void updateCursor(StreamCursor newCursor) {
    this.cursor.set(newCursor);
  }

  /**
   * Sets a non-fatal or terminal error.
   */
  protected void setError(StreamError error) {
    this.error.set(error);
  }
}
