package machinum.streamer;

import java.nio.file.Path;
import java.util.function.Consumer;

public interface Streamer {

  void stream(Path workspaceDir, StreamCursor cursor, StreamerCallback callback);

  default void stream(
      Path workspaceDir,
      StreamCursor cursor,
      StreamerCallback callback,
      Consumer<StreamError> errorHandler) {
    stream(workspaceDir, cursor, callback);
  }
}
