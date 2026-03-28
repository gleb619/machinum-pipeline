package machinum.tool;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import lombok.AllArgsConstructor;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.Tool;
import machinum.ToolRegistry;
import machinum.pipeline.ExecutionContext;
import machinum.yaml.ToolDefinition;

@Slf4j
@AllArgsConstructor
public class InMemoryToolRegistry implements ToolRegistry {

  private final Map<String, Tool> tools;
  private final Map<String, InternalToolFactory> internalToolFactories;

  /** Creates a new registry with empty tool maps. */
  //TODO: Use lombok's contructor instead
  @Deprecated(forRemoval = true)
  public InMemoryToolRegistry() {
    this.tools = new ConcurrentHashMap<>();
    this.internalToolFactories = new ConcurrentHashMap<>();
  }

  @Override
  public void register(Tool tool) {
    tools.put(tool.definition().name(), tool);
  }

  @Override
  public Optional<Tool> resolve(String name) {
    return Optional.ofNullable(tools.get(name));
  }

  @Override
  public boolean contains(String name) {
    return tools.containsKey(name);
  }

  /**
   * Registers an internal tool factory.
   *
   * <p>Internal tool factories are used to create internal tool instances from YAML definitions.
   * Register your tool factory during application initialization.
   *
   * @param factory the internal tool factory to register
   */
  // TODO: Unused
  @Deprecated(forRemoval = true)
  public void registerInternalToolFactory(InternalToolFactory factory) {
    internalToolFactories.put(factory.getToolName(), factory);
    log.debug(
        "Registered internal tool factory: {} -> {}",
        factory.getToolName(),
        factory.getClass().getName());
  }

  /**
   * Registers all internal tools from the given definitions.
   *
   * <p>For each internal tool definition, this method attempts to create an instance using a
   * registered factory. If no factory is found, a stub is created.
   *
   * @param definitions the tool definitions to register
   */
  public void registerAll(List<ToolDefinition> definitions) {
    for (ToolDefinition def : definitions) {
      if (def.isInternal()) {
        Tool tool = createInternalTool(def);
        if (tool != null) {
          register(tool);
        }
      } else if (def.isExternal()) {
        // External tools are handled separately by their runtime implementations
        log.debug("Skipping external tool registration: {}", def.name());
      }
    }
  }

  /**
   * Creates an internal tool instance from its definition.
   *
   * @param def the tool definition
   * @return the tool instance, or null if no factory found and not a known internal tool
   */
  private Tool createInternalTool(ToolDefinition def) {
    // Try to find a registered factory
    InternalToolFactory factory = internalToolFactories.get(def.name());
    if (factory != null) {
      try {
        return factory.create(def);
      } catch (Exception e) {
        log.error(
            "Failed to create internal tool '{}' using factory {}",
            def.name(),
            factory.getClass().getName(),
            e);
        return null;
      }
    }

    // Fallback: return stub for unknown internal tools
    log.debug("No factory found for internal tool '{}', creating stub", def.name());
    return new InternalToolStub(def);
  }

  /** Factory interface for creating internal tool instances. */
  public interface InternalToolFactory {

    /**
     * Returns the tool name that this factory creates.
     *
     * @return the tool name
     */
    String getToolName();

    /**
     * Creates a new internal tool instance.
     *
     * @param definition the tool definition from YAML
     * @return the internal tool instance
     */
    InternalTool create(ToolDefinition definition);
  }

  /** Stub implementation for internal tools without a registered factory. */
  @RequiredArgsConstructor
  // TODO: TO Remove
  @Deprecated(forRemoval = true)
  private static class InternalToolStub implements Tool {

    private final ToolDefinition definition;

    @Override
    public ToolDefinition definition() {
      return definition;
    }

    @Override
    public ToolResult execute(ExecutionContext context) {
      Map<String, Object> outputs = new HashMap<>();
      outputs.put("tool", definition.name());
      outputs.put("type", definition.type());
      outputs.put("status", "stub - no implementation registered");
      return ToolResult.success(outputs);
    }
  }
}
