package machinum.executor;

import static machinum.config.CoreConfig.coreConfig;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.bootstrap.BootstrapContext;
import machinum.manifest.ToolsBody.BootstrapToolManifest;
import machinum.manifest.ToolsBody.ToolRegistryType;
import machinum.tool.HttpToolRegistry;
import machinum.tool.ToolRegistry;

@Slf4j
@RequiredArgsConstructor
public class ToolsExecutor {

  public LifecycleContext executeDownload(LifecycleContext ctx) {
    log.info("Executing DOWNLOAD phase");

    if (ctx.toolsManifest().isEmpty()) {
      log.debug("No tools manifest found, skipping DOWNLOAD phase");
      return ctx;
    }

    var toolsManifest = ctx.toolsManifest().get();
    String registryUri = toolsManifest.body().registry();
    ToolRegistryType registryType = determineRegistryType(registryUri);

    log.info("Using {} tool registry for DOWNLOAD phase", registryType);

    if (Objects.requireNonNull(registryType) == ToolRegistryType.http) {
      log.debug("Http ToolRegistry: downloading jars from github registry to cache...");
      ToolRegistry registry = acquireRegistry(ctx, registryUri, registryType);
      if (registry instanceof HttpToolRegistry httpRegistry) {
        httpRegistry.refresh();
      }
    }

    log.info("DOWNLOAD phase completed");
    return ctx;
  }

  public LifecycleContext executeBootstrap(LifecycleContext ctx, boolean force) {
    log.info("Executing BOOTSTRAP phase (force={})", force);

    bootstrapAllTools(ctx, force);

    log.info("BOOTSTRAP phase completed");
    return ctx;
  }

  public LifecycleContext executeAfterBootstrap(LifecycleContext ctx) {
    log.info("Executing AFTER_BOOTSTRAP phase");

    afterBootstrapAllTools(ctx);

    log.info("AFTER_BOOTSTRAP phase completed");
    return ctx;
  }

  private void bootstrapAllTools(LifecycleContext ctx, boolean force) {
    if (ctx.toolsManifest().isPresent()) {
      var toolsManifest = ctx.toolsManifest().get();
      String registryUri = toolsManifest.body().registry();
      ToolRegistryType registryType = determineRegistryType(registryUri);
      var toolRegistry = acquireRegistry(ctx, registryUri, registryType);

      if (toolRegistry == null) {
        throw new IllegalArgumentException(
            "No tools registered in registry, skipping installation");
      }

      try {
        Map<String, Object> variables = ctx.root().body().variables().get();
        Map<String, String> secrets = ctx.root().body().secrets().asMap();

        List<String> targetTools = toolsManifest.body().bootstrap() != null
            ? toolsManifest.body().bootstrap().stream()
                .map(BootstrapToolManifest::name)
                .toList()
            : List.of();

        var bootstrapContext = BootstrapContext.builder()
            .workspaceRoot(ctx.workspaceDir())
            .secrets(Map.copyOf(secrets))
            .data(new HashMap<>(variables))
            .force(force)
            .build();

        toolRegistry.bootstrapAll(bootstrapContext, targetTools);
        log.info("All tools installed successfully");
      } catch (Exception e) {
        log.error("Failed to bootstrap tools", e);
        throw new RuntimeException("Failed to bootstrap tools: " + e.getMessage(), e);
      }
    } else {
      throw new RuntimeException(
          "No tools manifest found. Please ensure the workspace is initialized via 'machinum setup'.");
    }
  }

  private void afterBootstrapAllTools(LifecycleContext ctx) {
    if (ctx.toolsManifest().isPresent()) {
      var toolsManifest = ctx.toolsManifest().get();
      String registryUri = toolsManifest.body().registry();
      ToolRegistryType registryType = determineRegistryType(registryUri);
      var toolRegistry = acquireRegistry(ctx, registryUri, registryType);

      if (toolRegistry == null) {
        throw new IllegalArgumentException(
            "No tools registered in registry, skipping after bootstrap");
      }

      try {
        Map<String, Object> variables = ctx.root().body().variables().get();
        Map<String, String> secrets = ctx.root().body().secrets().asMap();

        List<String> targetTools = toolsManifest.body().bootstrap() != null
            ? toolsManifest.body().bootstrap().stream()
                .map(BootstrapToolManifest::name)
                .toList()
            : List.of();

        var bootstrapContext = BootstrapContext.builder()
            .workspaceRoot(ctx.workspaceDir())
            .secrets(Map.copyOf(secrets))
            .data(new HashMap<>(variables))
            .force(Boolean.FALSE)
            .build();

        toolRegistry.afterBootstrapAll(bootstrapContext, targetTools);
        log.info("All tools after-bootstrapped successfully");
      } catch (Exception e) {
        log.error("Failed to after bootstrap tools", e);
        throw new RuntimeException("Failed to after bootstrap tools: " + e.getMessage(), e);
      }
    } else {
      throw new RuntimeException(
          "No tools manifest found. Please ensure of workspace is initialized via 'machinum setup'.");
    }
  }

  private ToolRegistryType determineRegistryType(String registryUri) {
    if (registryUri == null || registryUri.startsWith("classpath://")) {
      return ToolRegistryType.builtin;
    }
    if (registryUri.startsWith("file://")) {
      return ToolRegistryType.file;
    }
    if (registryUri.startsWith("http://") || registryUri.startsWith("https://")) {
      return ToolRegistryType.http;
    }

    throw new IllegalArgumentException(
        "Invalid registry URI: '%s'. Must be one of: builtin, file, http, or a valid URI (classpath://, file://, http://, https://)"
            .formatted(registryUri));
  }

  private ToolRegistry acquireRegistry(
      LifecycleContext ctx, String registryUri, ToolRegistryType registryType) {
    return switch (registryType) {
      case file -> {
        String path = extractPathFromUri(registryUri);
        yield coreConfig().fileToolRegistry(Path.of(path));
      }
      case http -> coreConfig().httpToolRegistry(ctx.workspaceDir(), registryUri, null);
      case builtin -> coreConfig().builtInToolRegistry();
    };
  }

  private String extractPathFromUri(String uri) {
    if (uri == null || !uri.startsWith("file://")) {
      return ".mt/tools";
    }
    String path = uri.substring("file://".length());
    if (path.startsWith("/")) {
      return path;
    }
    return path;
  }
}
