package machinum;

import java.util.Optional;

public interface ToolRegistry {

  void register(Tool tool);

  Optional<Tool> resolve(String name);

  //TODO: Unused
  @Deprecated(forRemoval = true)
  boolean contains(String name);
}
