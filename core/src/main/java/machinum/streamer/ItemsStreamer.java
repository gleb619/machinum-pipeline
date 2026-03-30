package machinum.streamer;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import machinum.definition.PipelineDefinition.ItemsDefinition;

public final class ItemsStreamer implements Streamer {

  private final ItemsDefinition items;

  public ItemsStreamer(ItemsDefinition items) {
    this.items = items;
  }

  @Override
  public List<Map<String, Object>> stream(Path workspaceDir) {
    // TODO: Implement items streaming based on type (chapter, paragraph, line, document, page)
    // For now, return empty list
    return List.of();
  }
}
