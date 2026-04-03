package machinum.streamer;

import java.nio.file.Path;
import java.util.List;
import java.util.function.Consumer;

/**
 * Stream producer that feeds items into the pipeline.
 *
 * <p>Supports two consumption modes:
 *
 * <ul>
 *   <li><b>Synchronous (deprecated)</b> — returns a full list, blocking until all items loaded
 *   <li><b>Observer-style</b> — pushes batches to a {@link StreamerCallback} with resume and error
 *       tolerance
 * </ul>
 *
 * <p>See:
 *
 * <ul>
 *   <li>{@link StreamItem} — typed item replacing raw {@code Map<String, Object>}
 *   <li>{@link StreamCursor} — resume/batch position
 *   <li>{@link StreamError} — non-fatal error reporting
 *   <li>{@link StreamerCallback} — batch consumer
 *   <li><a href="../../../../docs/core-architecture.md#1-base-models-mvp">Core Architecture §1</a>
 *   <li><a href="../../../../docs/yaml-schema.md#4x-source-vs-items--data-acquisition-layer">YAML
 *       Schema §4.x</a>
 * </ul>
 */
public sealed interface Streamer permits ItemsStreamer, SourceStreamer {

  /**
   * Synchronous streaming (deprecated — prefer observer-style).
   *
   * <p>Blocks until all items are loaded. Does not support resume or error tolerance.
   *
   * @param workspaceDir workspace root
   * @return all items as a list
   * @deprecated Use {@link #stream(Path, StreamCursor, StreamerCallback)} instead.
   */
  @Deprecated(forRemoval = true)
  List<StreamItem> stream(Path workspaceDir);

  /**
   * Observer-style streaming with batch support and resume capability.
   *
   * <p>The streamer pushes batches to the callback. Each batch is followed by a cursor update that
   * can be persisted for checkpoint/resume. Connection and IO errors are handled gracefully — the
   * stream continues after error reporting.
   *
   * @param workspaceDir workspace root
   * @param cursor resume position ({@code null} for fresh start)
   * @param callback invoked per batch; return {@code false} to stop
   */
  void stream(Path workspaceDir, StreamCursor cursor, StreamerCallback callback);

  /**
   * Error-tolerant streaming — errors are forwarded to the handler instead of breaking the stream.
   *
   * @param workspaceDir workspace root
   * @param cursor resume position
   * @param callback invoked per batch
   * @param errorHandler invoked on non-fatal errors
   */
  default void stream(
      Path workspaceDir,
      StreamCursor cursor,
      StreamerCallback callback,
      Consumer<StreamError> errorHandler) {
    stream(workspaceDir, cursor, callback);
  }
}
