package machinum.checkpoint;

import java.io.IOException;
import java.util.Optional;

/** Abstraction for checkpoint persistence operations. */
public interface CheckpointStore {

  /**
   * Saves a checkpoint snapshot.
   *
   * @param snapshot the checkpoint to save
   * @throws IOException if saving fails
   */
  void save(CheckpointSnapshot snapshot) throws IOException;

  /**
   * Loads the latest checkpoint for a run.
   *
   * @param runId the run identifier
   * @return the checkpoint if it exists
   * @throws IOException if loading fails
   */
  Optional<CheckpointSnapshot> load(String runId) throws IOException;

  /**
   * Deletes a checkpoint for a run.
   *
   * @param runId the run identifier
   * @return true if the checkpoint was deleted
   * @throws IOException if deletion fails
   */
  boolean delete(String runId) throws IOException;

  /** Returns true if a checkpoint exists for the given run. */
  boolean exists(String runId) throws IOException;
}
