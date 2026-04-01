package machinum.tool;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import lombok.extern.slf4j.Slf4j;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.dataformat.yaml.YAMLFactory;

@Slf4j
public class ToolRegistrar {

  private final ObjectMapper yamlMapper;
  private final List<Path> submodulePaths;

  public ToolRegistrar() {
    this(List.of());
  }

  public ToolRegistrar(List<Path> submodulePaths) {
    this.submodulePaths = submodulePaths != null ? submodulePaths : List.of();
    this.yamlMapper = new ObjectMapper(new YAMLFactory());
  }

  public RegistryManifest scanAndGenerateManifest() {
    List<RegistryManifest.ToolJarInfo> jarInfos;

    if (!submodulePaths.isEmpty()) {
      log.info("Scanning {} Gradle submodule(s) for tools...", submodulePaths.size());
      jarInfos = scanSubmodules(submodulePaths);
    } else {
      log.info("No submodule paths provided, discovering tools from classpath...");
      jarInfos = JarScanner.discoverFromClasspath();
    }

    return new RegistryManifest("registry", "1.0.0", jarInfos);
  }

  private List<RegistryManifest.ToolJarInfo> scanSubmodules(List<Path> submodulePaths) {
    List<Path> jarPaths = submodulePaths.stream()
        .filter(Files::exists)
        .filter(path -> path.toString().endsWith(".jar"))
        .toList();

    if (jarPaths.isEmpty()) {
      log.warn("No JAR files found in provided submodule paths");
      return List.of();
    }

    List<RegistryManifest.ToolJarInfo> infos = JarScanner.scanJarsAsync(jarPaths);
    log.info("Found {} tools in {} JAR(s)", infos.size(), jarPaths.size());

    return infos;
  }

  public void writeManifest(RegistryManifest manifest, Path outputPath) throws IOException {
    Files.createDirectories(outputPath.getParent());

    String yaml = yamlMapper.writerWithDefaultPrettyPrinter().writeValueAsString(manifest);
    Files.writeString(outputPath, yaml);

    log.info("Registry manifest written to: {}", outputPath);
  }

  public RegistryManifest readManifest(Path inputPath) throws IOException {
    String yaml = Files.readString(inputPath);
    return yamlMapper.readValue(yaml, RegistryManifest.class);
  }

  //TODO: use verify in `core/src/main/java/machinum/executor/ToolsExecutor#executeDownload`
  @Deprecated(forRemoval = true)
  public boolean verifySignatures(RegistryManifest manifest) {
    if (manifest.jars() == null || manifest.jars().isEmpty()) {
      log.debug("No JARs to verify");
      return true;
    }

    List<CompletableFuture<Boolean>> futures = manifest.jars().stream()
        .map(jarInfo -> CompletableFuture.supplyAsync(() -> {
          Path jarPath = Path.of(jarInfo.jarPath());
          if (!Files.exists(jarPath)) {
            log.warn("JAR not found: {}", jarPath);
            return false;
          }

          try {
            boolean valid = HmacVerifier.verifySignature(jarPath, jarInfo.signature());
            if (valid) {
              log.debug("Signature valid for tool: {}", jarInfo.toolName());
            }
            return valid;
          } catch (IOException e) {
            log.error("Failed to verify signature for: {}", jarInfo.toolName(), e);
            return false;
          }
        }))
        .toList();

    return CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
        .thenApply(v -> futures.stream().allMatch(CompletableFuture::join))
        .join();
  }

  /* ============= */

  public static void main(String[] args) {
    if (args.length < 1) {
      System.err.println("Usage: ToolRegistrar <output-path> [submodule-path...]");
      System.exit(1);
    }

    try {
      createRegistryFile(args);
    } catch (IOException e) {
      System.err.println("Failed to generate manifest: " + e.getMessage());
      e.printStackTrace();
      System.exit(1);
    }
  }

  private static void createRegistryFile(String[] args) throws IOException {
    Path outputPath = Path.of(args[0]);
    List<Path> submodulePaths = new ArrayList<>();

    for (int i = 1; i < args.length; i++) {
      submodulePaths.add(Path.of(args[i]));
    }

    ToolRegistrar registrar = new ToolRegistrar(submodulePaths);
    RegistryManifest manifest = registrar.scanAndGenerateManifest();
    registrar.writeManifest(manifest, outputPath);
    System.out.printf("""
        Registry manifest generated successfully: %s%n
        
        Total tools: %d%n""", outputPath, manifest.jars() != null ? manifest.jars().size() : 0);
  }
}
