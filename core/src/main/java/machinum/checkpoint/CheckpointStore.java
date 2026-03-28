package machinum.checkpoint;

import java.io.IOException;
import java.util.Optional;

public interface CheckpointStore {

  void save(CheckpointSnapshot snapshot) throws IOException;

  Optional<CheckpointSnapshot> load(String runId) throws IOException;

  boolean delete(String runId) throws IOException;

  boolean exists(String runId) throws IOException;
}
