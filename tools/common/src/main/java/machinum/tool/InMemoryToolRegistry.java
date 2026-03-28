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
import machinum.manifest.ToolManifestDepricated;
import machinum.pipeline.ExecutionContext;

@Slf4j
@AllArgsConstructor
public class InMemoryToolRegistry implements ToolRegistry {

  private final Map<String, Tool> tools;
  private final Map<String, InternalToolFactory> internalToolFactories;

  // TODO: Use lombok's contructor instead
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

  // TODO: Unused
  @Deprecated(forRemoval = true)
  public void registerInternalToolFactory(InternalToolFactory factory) {
    internalToolFactories.put(factory.getToolName(), factory);
    log.debug(
        "Registered internal tool factory: {} -> {}",
        factory.getToolName(),
        factory.getClass().getName());
  }

  public void registerAll(List<ToolManifestDepricated> definitions) {
    for (ToolManifestDepricated def : definitions) {
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

  private Tool createInternalTool(ToolManifestDepricated def) {
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

  public interface InternalToolFactory {

    String getToolName();

    InternalTool create(ToolManifestDepricated definition);
  }

  @RequiredArgsConstructor
  // TODO: TO Remove
  @Deprecated(forRemoval = true)
  private static class InternalToolStub implements Tool {

    private final ToolManifestDepricated definition;

    @Override
    public ToolManifestDepricated definition() {
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
