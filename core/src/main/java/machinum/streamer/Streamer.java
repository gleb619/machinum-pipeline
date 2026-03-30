package machinum.streamer;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

public sealed interface Streamer permits ItemsStreamer, SourceStreamer {

  List<Map<String, Object>> stream(Path workspaceDir);
}
