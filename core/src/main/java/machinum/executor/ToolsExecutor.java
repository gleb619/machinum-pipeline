package machinum.executor;

import static machinum.config.CoreConfig.coreConfig;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.bootstrap.BootstrapContext;
import machinum.manifest.ToolsBody.ToolRegistryConfigManifest;
import machinum.manifest.ToolsBody.ToolRegistryType;
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

    var registryManifest = ctx.toolsManifest().get().body().registry();
    ToolRegistryType registryType = determineRegistryType(registryManifest);

    log.info("Using {} tool registry for DOWNLOAD phase", registryType);

    switch (registryType) {
      case builtin -> {
        log.info("BuiltIn ToolRegistry: checking local gradle 'kitchen'");
        // TODO: check if jars exist in the tool directory; if not, trigger gradle jar build
      }
      case file -> {
        log.info("File ToolRegistry: using SPI tools from classpath. No download required.");
        // TODO: Check hmac before use, if any jars is compromised, stop executing
      }
      case http -> {
        log.info("Http ToolRegistry: downloading jars from github registry to cache...");
        // TODO: download jars and place somewhere in tools cache
        // (see machinum.workspace.WorkspaceLayout#getToolsCacheDir)
        // Then reuse FileToolRegistry inside HttpToolRegistry loop.
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

  //TODO: Redo, add profiles. For Dev use `builtin` for other http
  @Deprecated(forRemoval = true)
  private void bootstrapAllTools(LifecycleContext ctx, boolean force) {
    // If tools manifest exists, use it; otherwise use SPI tools directly
    if (ctx.toolsManifest().isPresent()) {
      var toolsManifest = ctx.toolsManifest().get();
      var registryManifest = toolsManifest.body().registry();
      ToolRegistryType registryType = determineRegistryType(registryManifest);
      var toolRegistry = acquireRegistry(ctx, registryManifest, registryType);

      if (toolRegistry == null) {
        throw new IllegalArgumentException(
            "No tools registered in registry, skipping installation");
      }

      try {
        Map<String, Object> variables = ctx.root().body().variables().get();
        Map<String, String> secrets = ctx.root().body().secrets().asMap();
        BootstrapContext bootstrapContext = BootstrapContext.builder()
            .workspaceRoot(ctx.workspaceDir())
            .secrets(Map.copyOf(secrets))
            .data(new HashMap<>(variables))
            .force(force)
            .build();

        toolRegistry.bootstrapAll(bootstrapContext);
        log.info("All tools installed successfully");
      } catch (Exception e) {
        log.error("Failed to bootstrap tools", e);
        throw new RuntimeException("Failed to bootstrap tools: " + e.getMessage(), e);
      }
    } else {
      //TODO: If tools manifest not provided, then throw exception. Check
      // `tools/internal/src/main/java/machinum/workspace/WorkspaceInitializerTool.java`

      // No tools manifest - use SPI tools directly
      log.info("No tools manifest found, using SPI tools directly");
      try {
        var toolRegistry = coreConfig().fileToolRegistry();
        BootstrapContext bootstrapContext = BootstrapContext.builder()
            .workspaceRoot(ctx.workspaceDir())
            .secrets(Map.of())
            .data(Map.of())
            .force(force)
            .build();

        toolRegistry.bootstrapAll(bootstrapContext);
        log.info("All SPI tools installed successfully");
      } catch (Exception e) {
        log.error("Failed to bootstrap SPI tools", e);
        throw new RuntimeException("Failed to bootstrap SPI tools: " + e.getMessage(), e);
      }
    }
  }

  /**
   * Determines registry type based on dev/release mode.
   * <p>
   * Dev mode (build.gradle exists): uses builtin registry
   * Release mode: uses configured type or defaults to http
   * </p>
   */
  private ToolRegistryType determineRegistryType(ToolRegistryConfigManifest manifest) {
    // Check if running in dev mode (Gradle project exists)
    Path gradleProject = Paths.get("").normalize().toAbsolutePath();
    boolean isDevMode = Files.exists(gradleProject.resolve("build.gradle"));

    if (isDevMode) {
      log.info("Dev mode detected: using builtin tool registry");
      return ToolRegistryType.builtin;
    }

    // Release mode: use configured type or default to http
    ToolRegistryType type = manifest.type() != null ? manifest.type() : ToolRegistryType.http;
    log.info("Release mode detected: using {} tool registry", type);
    return type;
  }

  private ToolRegistry acquireRegistry(
      LifecycleContext ctx, ToolRegistryConfigManifest registryManifest, ToolRegistryType registryType) {
    return switch (registryType) {
      case file -> coreConfig().fileToolRegistry();
      case http ->
        coreConfig()
            .httpToolRegistry(
                ctx.workspaceDir(), registryManifest.url(), registryManifest.refresh());
      case builtin ->
        coreConfig().builtInToolRegistry(Paths.get("").normalize().toAbsolutePath());
    };
  }
}
