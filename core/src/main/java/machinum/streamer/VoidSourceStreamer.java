package machinum.streamer;

import java.nio.file.Path;
import java.util.function.Consumer;
import lombok.extern.slf4j.Slf4j;

/**
 * Streamer for void:// URIs - emits no items and completes immediately. Useful for testing,
 * validation, and pipelines that don't require input data.
 */
@Slf4j
public final class VoidSourceStreamer implements Streamer {

  @Override
  public void stream(Path workspaceDir, StreamCursor cursor, StreamerCallback callback) {
    stream(workspaceDir, cursor, callback, error -> log.warn("Void streamer error: {}", error));
  }

  @Override
  public void stream(
      Path workspaceDir,
      StreamCursor cursor,
      StreamerCallback callback,
      Consumer<StreamError> errorHandler) {

    StreamCursor cur = cursor != null ? cursor : StreamCursor.initial();

    log.debug("VoidSourceStreamer: starting stream");
    callback.onStreamStart(cur);

    // No items to emit - complete immediately
    callback.onStreamEnd(cur);

    log.debug("VoidSourceStreamer: stream completed (0 items)");
  }
}
