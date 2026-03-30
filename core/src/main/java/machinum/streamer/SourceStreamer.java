package machinum.streamer;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import machinum.definition.PipelineDefinition.SourceDefinition;

public final class SourceStreamer implements Streamer {

  private final SourceDefinition source;

  public SourceStreamer(SourceDefinition source) {
    this.source = source;
  }

  @Override
  public List<Map<String, Object>> stream(Path workspaceDir) {
    // TODO: Implement source streaming based on type (file, http, git, s3)
    // For now, return empty list
    return List.of();
  }
}
