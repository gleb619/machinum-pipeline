package machinum.checkpoint;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import tools.jackson.databind.ObjectMapper;

/** Filesystem-backed checkpoint store using local storage under .mt/state/<run-id>/. */
@RequiredArgsConstructor
public class FileCheckpointStore implements CheckpointStore {

  private static final String CHECKPOINT_FILE = "checkpoint.json";

  private final Path baseDir;
  private final ObjectMapper objectMapper;

  @Override
  public void save(CheckpointSnapshot snapshot) throws IOException {
    Path runDir = getRunDir(snapshot.runId());
    Files.createDirectories(runDir);

    Path checkpointFile = runDir.resolve(CHECKPOINT_FILE);
    objectMapper.writeValue(checkpointFile.toFile(), snapshot);
  }

  @Override
  public Optional<CheckpointSnapshot> load(String runId) throws IOException {
    Path checkpointFile = getRunDir(runId).resolve(CHECKPOINT_FILE);

    if (!Files.exists(checkpointFile)) {
      return Optional.empty();
    }

    CheckpointSnapshot snapshot =
        objectMapper.readValue(checkpointFile.toFile(), CheckpointSnapshot.class);
    return Optional.of(snapshot);
  }

  @Override
  public boolean delete(String runId) throws IOException {
    Path runDir = getRunDir(runId);
    if (!Files.exists(runDir)) {
      return false;
    }

    Path checkpointFile = runDir.resolve(CHECKPOINT_FILE);
    if (Files.exists(checkpointFile)) {
      Files.delete(checkpointFile);
    }

    if (Files.list(runDir).findAny().isEmpty()) {
      Files.delete(runDir);
    }

    return true;
  }

  @Override
  public boolean exists(String runId) throws IOException {
    Path checkpointFile = getRunDir(runId).resolve(CHECKPOINT_FILE);
    return Files.exists(checkpointFile);
  }

  private Path getRunDir(String runId) {
    return baseDir.resolve(runId);
  }
}
