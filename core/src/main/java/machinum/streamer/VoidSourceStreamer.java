package machinum.streamer;

import java.nio.file.Path;
import lombok.extern.slf4j.Slf4j;

@Slf4j
public final class VoidSourceStreamer implements Streamer {

  @Override
  public StreamResult stream(Path workspaceDir, String runId) {
    log.debug("VoidSourceStreamer: returning empty stream");
    return AbstractStreamResult.empty();
  }
}
