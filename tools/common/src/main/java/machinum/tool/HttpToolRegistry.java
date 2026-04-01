package machinum.tool;

import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.time.temporal.ChronoUnit;
import java.util.Optional;
import lombok.SneakyThrows;
import lombok.extern.slf4j.Slf4j;
import machinum.bootstrap.BootstrapContext;
import machinum.pipeline.ExecutionContext;
import machinum.tool.Tool.ToolResult;
import machinum.workspace.WorkspaceLayout;

@Slf4j
//TODO: Redo:
//  core/src/main/java/machinum/executor/Executor.java
//  core/src/main/java/machinum/executor/PipelineExecutor.java
//  core/src/main/java/machinum/executor/ToolsExecutor.java
//  We need to call a `HttpToolRegistry#refresh` somewhere in executor lifecycle chain
@Deprecated(forRemoval = true)
public class HttpToolRegistry implements ToolRegistry {

  //TODO: Redo to input arg, like `baseUrl`
  @Deprecated(forRemoval = true)
  private static final Duration REGISTRY_TIMEOUT = Duration.of(2, ChronoUnit.MINUTES);

  private final String baseUrl;
  private final String refreshStrategy;
  private final Path cacheDirectory;
  private final FileToolRegistry delegate;
  private final HttpClient httpClient;

  public HttpToolRegistry(Path workspaceRoot, String baseUrl, String refreshStrategy) {
    this.baseUrl = baseUrl;
    this.refreshStrategy = refreshStrategy != null ? refreshStrategy : "on_startup";
    this.cacheDirectory = resolveCacheDirectory(workspaceRoot);
    this.delegate = new FileToolRegistry();
    this.httpClient = HttpClient.newHttpClient();
  }

  //TODO: Check some hash/state file, and download missed files
  @Deprecated(forRemoval = true)
  public HttpToolRegistry init() {
    if ("on_startup".equals(this.refreshStrategy)) {
      downloadAndLoadTools();
    }

    return this;
  }

  @SneakyThrows
  private Path resolveCacheDirectory(Path workspaceRoot) {
    var toolsCacheDir = new WorkspaceLayout(workspaceRoot).getToolsCacheDir();
    if(!Files.exists(toolsCacheDir)) {
      Files.createDirectories(toolsCacheDir);
    }

    return toolsCacheDir;
  }

  private void downloadAndLoadTools() {
    try {
      log.info("Downloading tools from: {}", baseUrl);

      HttpRequest request =
          HttpRequest.newBuilder().uri(URI.create(baseUrl)).timeout(REGISTRY_TIMEOUT).GET().build();

      HttpResponse<InputStream> response =
          httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());

      if (response.statusCode() != 200) {
        log.error("Failed to download tools: HTTP {}", response.statusCode());
        return;
      }

      Path cacheFile = cacheDirectory.resolve("registry.yaml");
      Files.copy(response.body(), cacheFile, StandardCopyOption.REPLACE_EXISTING);

      log.info("Tools downloaded and cached to: {}", cacheFile);

      // TODO: Parse the tools manifest and download individual tool JARs
      // For now, this is a placeholder for the full implementation
      // The full implementation would:
      // 1. Parse the tools.yaml to get tool definitions
      // 2. Download each tool JAR to the cache directory
      // 3. Transform paths/links as needed
      // 4. Load tools using a custom ClassLoader
      // 5. Create temp registry file, place it to tools cache folder, to use a `FileToolRegistry`

    } catch (Exception e) {
      log.error("Failed to download tools from: {}", baseUrl, e);
    }
  }

  @Override
  public void register(Tool tool) {
    delegate.register(tool);
  }

  @Override
  public Optional<Tool> resolve(String name) {
    return delegate.resolve(name);
  }

  @Override
  public ToolResult execute(String name, ExecutionContext context) {
    return delegate.execute(name, context);
  }

  @Override
  public void bootstrapAll(BootstrapContext context) throws Exception {
    delegate.bootstrapAll(context);
  }

  // TODO: Call method on next event in context reload
  public void refresh() {
    if ("never".equals(refreshStrategy)) {
      log.debug("Refresh strategy is 'never', skipping tool refresh");
      return;
    }

    downloadAndLoadTools();
  }
}
