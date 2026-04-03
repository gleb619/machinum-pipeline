package machinum.streamer;

import lombok.Builder;

/**
 * Tracks the current position within a stream for resume and batch support.
 *
 * <p>Maps directly to checkpoint fields documented in <a
 * href="../../../../docs/core-architecture.md#31-state-file-structure-mtstaterun-idcheckpointjson">Core
 * Architecture §3.1</a>:
 *
 * <ul>
 *   <li>{@code stateIndex} → {@code runner.state_index}
 *   <li>{@code itemOffset} → {@code runner.item_offset}
 *   <li>{@code windowId} → {@code runner.window_id}
 * </ul>
 *
 * <p>See {@link Streamer} for usage in observer-style streaming.
 */
@Builder
public record StreamCursor(int stateIndex, int itemOffset, int windowId, String runId) {

  /** Creates an initial cursor for a fresh run. */
  public static StreamCursor initial(String runId) {
    return new StreamCursor(0, 0, 0, runId);
  }

  /** Returns a new cursor advanced by the given batch size. */
  public StreamCursor advance(int batchSize) {
    return new StreamCursor(stateIndex, itemOffset + batchSize, windowId + 1, runId);
  }

  /** Returns a new cursor at the given state index. */
  public StreamCursor forState(int stateIndex) {
    return new StreamCursor(stateIndex, itemOffset, windowId, runId);
  }
}
