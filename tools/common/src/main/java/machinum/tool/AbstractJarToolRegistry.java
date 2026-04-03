package machinum.tool;

import java.io.IOException;
import java.net.MalformedURLException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.PriorityQueue;
import java.util.ServiceLoader;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;
import lombok.extern.slf4j.Slf4j;
import machinum.bootstrap.BootstrapContext;
import machinum.pipeline.ExecutionContext;
import machinum.tool.Tool.ToolResult;

@Slf4j
public abstract class AbstractJarToolRegistry implements ToolRegistry {

  protected final Map<String, Tool> tools = new ConcurrentHashMap<>();
  protected final List<URLClassLoader> classLoaders = new ArrayList<>();
  protected Path toolsDirectory;

  protected void loadToolsFromJars() {
    if (toolsDirectory == null || !Files.exists(toolsDirectory)) {
      log.debug("Tools directory does not exist or not set: {}", toolsDirectory);
      return;
    }

    try {
      List<Path> jarPaths;
      try (var jars = Files.list(toolsDirectory)) {
        jarPaths = jars.filter(path -> path.toString().endsWith(".jar")).toList();
      }

      if (jarPaths.isEmpty()) {
        log.debug("No JAR files found in: {}", toolsDirectory);
        return;
      }

      // Load all JARs into a single shared classloader
      List<URL> jarUrls = jarPaths.stream()
          .map(p -> {
            try {
              return p.toUri().toURL();
            } catch (MalformedURLException e) {
              log.error("Failed to convert JAR path to URL: {}", p, e);
              return null;
            }
          })
          .filter(url -> url != null)
          .toList();

      if (!jarUrls.isEmpty()) {
        URLClassLoader sharedLoader = new URLClassLoader(
            jarUrls.toArray(URL[]::new), AbstractJarToolRegistry.class.getClassLoader());
        classLoaders.add(sharedLoader);

        ServiceLoader<Tool> loader = ServiceLoader.load(Tool.class, sharedLoader);
        int count = 0;
        for (Tool tool : loader) {
          try {
            register(tool);
            count++;
            log.debug(
                "Loaded tool '{}' from JAR: {}", tool.info().name(), toolsDirectory.getFileName());
          } catch (Exception e) {
            log.error("Failed to register tool from JAR: {}", toolsDirectory, e);
          }
        }
        log.debug("Loaded {} tools from {} JAR(s) in: {}", count, jarPaths.size(), toolsDirectory);
      }
    } catch (IOException e) {
      log.error("Failed to list tools directory: {}", toolsDirectory, e);
    }
  }

  @Override
  public void register(Tool tool) {
    String name = tool.info().name();
    tools.put(name, tool);
    log.debug("Registered tool: {}", name);
  }

  @Override
  public Optional<Tool> resolve(String name) {
    Tool tool = tools.get(name);
    if (tool != null) {
      return Optional.of(tool);
    }
    log.debug("Tool not found: {}", name);
    return Optional.empty();
  }

  @Override
  public ToolResult execute(String name, ExecutionContext context) {
    Tool tool = tools.get(name);
    if (tool != null) {
      ClassLoader originalContextClassLoader = Thread.currentThread().getContextClassLoader();
      try {
        Thread.currentThread().setContextClassLoader(tool.getClass().getClassLoader());
        return tool.execute(context);
      } catch (Exception e) {
        throw new RuntimeException("Failed to execute tool: " + name, e);
      } finally {
        Thread.currentThread().setContextClassLoader(originalContextClassLoader);
      }
    }
    return ToolRegistry.super.execute(name, context);
  }

  @Override
  public void bootstrapAll(BootstrapContext context, List<String> targetTools) throws Exception {
    executeForAllTools(
        targetTools,
        tool -> {
          tool.bootstrap(context);
          log.debug("Successfully bootstrapped tool: {}", tool.info().name());
        },
        "bootstrap");
  }

  @Override
  public void afterBootstrapAll(BootstrapContext context, List<String> targetTools)
      throws Exception {
    executeForAllTools(
        targetTools,
        tool -> {
          tool.afterBootstrap(context);
          log.debug("Successfully after-bootstrapped tool: {}", tool.info().name());
        },
        "afterBootstrap");
  }

  private void executeForAllTools(
      List<String> targetTools, ThrowingConsumer<Tool, Exception> action, String phaseName)
      throws Exception {
    if (targetTools == null || targetTools.isEmpty()) {
      log.warn("No tools specified for {} phase.", phaseName);
      return;
    }

    List<Tool> selected = targetTools.stream()
        .map(name -> {
          Tool tool = tools.get(name);
          if (tool == null) {
            log.warn("Tool '{}' requested for {} but not found in registry", name, phaseName);
          }
          return tool;
        })
        .filter(tool -> tool != null)
        .toList();

    List<Tool> sortedTools = sortTools(selected);
    log.info(
        "{} tools: {}",
        Character.toUpperCase(phaseName.charAt(0)) + phaseName.substring(1),
        sortedTools.stream().map(tool -> tool.info().name()).collect(Collectors.joining(" -> ")));

    for (Tool tool : sortedTools) {
      ClassLoader originalContextClassLoader = Thread.currentThread().getContextClassLoader();
      try {
        Thread.currentThread().setContextClassLoader(tool.getClass().getClassLoader());
        action.accept(tool);
      } catch (Exception e) {
        log.error("Failed in {} for tool: {}", phaseName, tool.info().name(), e);
        throw e;
      } finally {
        Thread.currentThread().setContextClassLoader(originalContextClassLoader);
      }
    }
  }

  @FunctionalInterface
  private interface ThrowingConsumer<T, E extends Exception> {
    void accept(T t) throws E;
  }

  private List<Tool> sortTools(List<Tool> tools) {
    var toolMap = new HashMap<String, Tool>();
    for (var t : tools) {
      toolMap.put(t.info().name(), t);
    }

    var inDegree = new HashMap<String, Integer>();
    var graph = new HashMap<String, List<String>>();
    for (String name : toolMap.keySet()) {
      inDegree.put(name, 0);
      graph.put(name, new ArrayList<>());
    }

    for (var tool : tools) {
      var targetNode = tool.info().name();
      for (var dep : tool.dependsOn()) {
        if (toolMap.containsKey(dep)) {
          graph.get(dep).add(targetNode);
          inDegree.put(targetNode, inDegree.get(targetNode) + 1);
        } else {
          log.debug(
              "Dependency '{}' for tool '{}' is not in the bootstrap list, skipping.",
              dep,
              targetNode);
        }
      }
    }

    var queue = new PriorityQueue<String>((name1, name2) -> {
      var t1 = toolMap.get(name1);
      var t2 = toolMap.get(name2);
      int cmp = Integer.compare(t1.priority(), t2.priority());
      if (cmp != 0) return cmp;
      return name1.compareTo(name2);
    });

    for (var entry : inDegree.entrySet()) {
      if (entry.getValue() == 0) {
        queue.add(entry.getKey());
      }
    }

    var sorted = new ArrayList<Tool>();
    while (!queue.isEmpty()) {
      var current = queue.poll();
      sorted.add(toolMap.get(current));

      for (var neighbor : graph.get(current)) {
        inDegree.put(neighbor, inDegree.get(neighbor) - 1);
        if (inDegree.get(neighbor) == 0) {
          queue.add(neighbor);
        }
      }
    }

    if (sorted.size() != tools.size()) {
      throw new IllegalStateException("Circular dependency detected in tool bootstrap list!");
    }

    return sorted;
  }
}
