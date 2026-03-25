package machinum;

import java.util.Optional;

/** Registry for resolving tools by name. */
public interface ToolRegistry {

  /**
   * Registers a tool instance.
   *
   * @param tool the tool to register
   */
  void register(Tool tool);

  /**
   * Resolves a tool by name.
   *
   * @param name the tool name
   * @return the tool if found
   */
  Optional<Tool> resolve(String name);

  /** Returns true if a tool with the given name is registered. */
  boolean contains(String name);
}
