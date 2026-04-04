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
import java.util.List;
import java.util.Optional;
import lombok.SneakyThrows;
import lombok.extern.slf4j.Slf4j;
import machinum.bootstrap.BootstrapContext;
import machinum.pipeline.ExecutionContext;
import machinum.tool.Tool.ToolResult;
import machinum.workspace.WorkspaceLayout;

@Slf4j
public class HttpToolRegistry implements ToolRegistry {

  private final String baseUrl;
  private final Path cacheDirectory;
  private FileToolRegistry delegate;
  private final HttpClient httpClient;
  private final Duration registryTimeout;

  public HttpToolRegistry(Path workspaceRoot, String baseUrl, Duration registryTimeout) {
    this.baseUrl = baseUrl;
    this.registryTimeout = registryTimeout != null ? registryTimeout : Duration.ofMinutes(2);
    this.cacheDirectory = resolveCacheDirectory(workspaceRoot);
    this.delegate = new FileToolRegistry(this.cacheDirectory);
    this.httpClient = HttpClient.newHttpClient();
  }

  public HttpToolRegistry(Path workspaceRoot, String baseUrl, String refreshStrategy) {
    this(workspaceRoot, baseUrl, Duration.ofMinutes(2));
  }

  public HttpToolRegistry init() {
    downloadAndLoadTools();
    return this;
  }

  @SneakyThrows
  private Path resolveCacheDirectory(Path workspaceRoot) {
    var toolsCacheDir = new WorkspaceLayout(workspaceRoot).getToolsCacheDir();
    if (!Files.exists(toolsCacheDir)) {
      Files.createDirectories(toolsCacheDir);
    }
    return toolsCacheDir;
  }

  private void downloadAndLoadTools() {
    try {
      log.info("Downloading tools registry from: {}", baseUrl);

      HttpRequest request = HttpRequest.newBuilder()
          .uri(URI.create(baseUrl))
          .timeout(registryTimeout)
          .GET()
          .build();

      HttpResponse<InputStream> response =
          httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());

      if (response.statusCode() != 200) {
        log.error("Failed to download tools: HTTP {}", response.statusCode());
        return;
      }

      Path cacheFile = cacheDirectory.resolve("registry.yaml");
      Files.copy(response.body(), cacheFile, StandardCopyOption.REPLACE_EXISTING);

      log.info("Tools downloaded and cached to: {}", cacheFile);

      // Re-initialize the delegate so it scans the cacheDirectory for downloaded jars
      this.delegate = new FileToolRegistry(this.cacheDirectory);

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
  public void bootstrapAll(BootstrapContext context, List<String> targetTools) throws Exception {
    delegate.bootstrapAll(context, targetTools);
  }

  @Override
  public void afterBootstrapAll(BootstrapContext context, List<String> targetTools)
      throws Exception {
    delegate.afterBootstrapAll(context, targetTools);
  }

  public void refresh() {
    downloadAndLoadTools();
  }
}
