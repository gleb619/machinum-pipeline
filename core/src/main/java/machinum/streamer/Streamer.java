package machinum.streamer;

import java.nio.file.Path;

/**
 * Interface for streaming items from a source or collection.
 * Pull-based and integrated with the check-point system.
 */
public interface Streamer {

  /**
   * Creates a result from the specified workspace directory and run identifier.
   * If runId is provided, the streamer will automatically resume from the last saved checkpoint.
   */
  StreamResult stream(Path workspaceDir, String runId);
}
