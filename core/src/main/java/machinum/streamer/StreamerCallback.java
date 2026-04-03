package machinum.streamer;

import java.util.List;

/**
 * Observer-style callback for consuming batches from a {@link Streamer}.
 *
 * <p>The streamer pushes batches to this callback. The consumer signals whether to continue
 * ({@code true}) or stop ({@code false}) the stream.
 *
 * <p>Usage example:
 *
 * <pre>{@code
 * streamer.stream(workspaceDir, cursor, (items, cur) -> {
 *     for (StreamItem item : items) {
 *         processItem(item);
 *     }
 *     checkpointStore.save(cur);
 *     return !shutdownRequested;  // stop on SIGTERM
 * });
 * }</pre>
 *
 * <p>See:
 *
 * <ul>
 *   <li>{@link Streamer} — stream producer
 *   <li>{@link StreamCursor} — batch position tracking
 *   <li><a href="../../../../docs/core-architecture.md#3-checkpointing--state-management">Core
 *       Architecture §3</a>
 * </ul>
 */
@FunctionalInterface
public interface StreamerCallback {

  /**
   * Called when a batch of items is available.
   *
   * @param items batch of stream items
   * @param cursor current position for resume/checkpoint
   * @return {@code true} to continue streaming, {@code false} to stop
   */
  boolean onBatch(List<StreamItem> items, StreamCursor cursor);
}
