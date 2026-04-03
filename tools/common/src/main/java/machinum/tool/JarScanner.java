package machinum.tool;

import java.io.IOException;
import java.net.MalformedURLException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.ServiceLoader;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.stream.Collectors;
import lombok.AccessLevel;
import lombok.NoArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Slf4j
@NoArgsConstructor(access = AccessLevel.PRIVATE)
public final class JarScanner {

  private static final int DEFAULT_PARALLELISM =
      Math.max(Runtime.getRuntime().availableProcessors(), 4);

  public static List<RegistryManifest.ToolJarInfo> scanJarsAsync(List<Path> jarPaths) {
    Executor executor =
        Executors.newFixedThreadPool(Math.min(DEFAULT_PARALLELISM, jarPaths.size()));

    List<CompletableFuture<RegistryManifest.ToolJarInfo>> futures = jarPaths.stream()
        .map(jarPath -> CompletableFuture.supplyAsync(() -> scanJar(jarPath), executor))
        .toList();

    return CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
        .thenApply(v -> futures.stream()
            .map(CompletableFuture::join)
            .filter(Objects::nonNull)
            .collect(Collectors.toList()))
        .join();
  }

  public static RegistryManifest.ToolJarInfo scanJar(Path jarPath) {
    if (!Files.exists(jarPath) || !jarPath.toString().endsWith(".jar")) {
      return null;
    }

    try {
      URL jarUrl = jarPath.toUri().toURL();
      try (URLClassLoader classLoader =
          new URLClassLoader(new URL[] {jarUrl}, JarScanner.class.getClassLoader())) {

        ServiceLoader<Tool> loader = ServiceLoader.load(Tool.class, classLoader);
        List<Tool> tools = new ArrayList<>();

        for (Tool tool : loader) {
          tools.add(tool);
        }

        if (tools.isEmpty()) {
          log.debug("No tools found in JAR: {}", jarPath.getFileName());
          return null;
        }

        String signature = HmacVerifier.generateSignature(jarPath);

        Tool firstTool = tools.getFirst();
        return RegistryManifest.ToolJarInfo.builder()
            .toolName(firstTool.info().name())
            .jarPath(jarPath.toAbsolutePath().toString())
            .className(firstTool.getClass().getName())
            .dependencies(List.of())
            .signature(signature)
            .build();
      }
    } catch (MalformedURLException e) {
      log.error("Failed to load JAR: {}", jarPath, e);
      return null;
    } catch (IOException e) {
      log.error("Failed to generate signature for JAR: {}", jarPath, e);
      return null;
    }
  }

  public static List<RegistryManifest.ToolJarInfo> discoverFromClasspath() {
    List<RegistryManifest.ToolJarInfo> infos = new ArrayList<>();
    ServiceLoader<Tool> loader = ServiceLoader.load(Tool.class);

    for (Tool tool : loader) {
      try {
        String jarPath = resolveJarPath(tool.getClass());
        String signature = "classpath";

        RegistryManifest.ToolJarInfo info = RegistryManifest.ToolJarInfo.builder()
            .toolName(tool.info().name())
            .jarPath(jarPath)
            .className(tool.getClass().getName())
            .dependencies(List.of())
            .signature(signature)
            .build();

        infos.add(info);
        log.info("Discovered tool: {} (class: {})", info.toolName(), info.className());
      } catch (Exception e) {
        log.error("Failed to extract tool info: {}", tool.getClass().getName(), e);
      }
    }

    return infos;
  }

  private static String resolveJarPath(Class<?> clazz) {
    try {
      String classFile = clazz.getName().replace('.', '/') + ".class";
      var url = clazz.getClassLoader().getResource(classFile);

      if (url != null) {
        String protocol = url.getProtocol();

        if ("jar".equals(protocol)) {
          String jarUrl = url.getPath();
          int separator = jarUrl.indexOf("!");
          if (separator > 0) {
            return jarUrl.substring(0, separator);
          }
        } else if ("file".equals(protocol)) {
          return "directory:" + url.getPath();
        }
      }
    } catch (Exception e) {
      log.warn("Failed to resolve JAR path for class: {}", clazz.getName(), e);
    }

    return "unknown";
  }
}
