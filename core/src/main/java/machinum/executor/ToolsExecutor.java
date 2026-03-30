package machinum.executor;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import machinum.pipeline.ExecutionContext;
import machinum.tool.SpiToolRegistry;
import machinum.workspace.WorkspaceLayout;

@Slf4j
@RequiredArgsConstructor
public class ToolsExecutor {

  private final SpiToolRegistry toolRegistry;

  public Executor.LifecycleContext executeDownload(Executor.LifecycleContext ctx) {
    log.info("Executing DOWNLOAD phase");

    if (ctx.toolsManifest().isEmpty()) {
      log.debug("No tools manifest found, skipping DOWNLOAD phase");
      return ctx;
    }

    // For SPI-based tools, no download is needed - they're already on classpath
    // For external tools with git/http sources, download would happen here
    // TODO: Implement tool source resolution and download for non-SPI tools
    // - Iterate through ToolsDefinition.tools
    // - Resolve source type (spi|git|http|file)
    // - Download to .mt/tools/ cache for non-SPI sources
    // - Validate source integrity

    log.info("DOWNLOAD phase completed (SPI tools already on classpath)");
    return ctx;
  }

  public Executor.LifecycleContext executeBootstrap(Executor.LifecycleContext ctx, boolean force) {
    log.info("Executing BOOTSTRAP phase (force={})", force);

    Path workspaceDir = ctx.workspaceDir();
    WorkspaceLayout layout = new WorkspaceLayout(workspaceDir);

    try {
      // Create directory structure
      layout.createDirectories();

      // Install all SPI-discovered internal tools
      installAllTools(ctx);

      log.info("BOOTSTRAP phase completed");
      return ctx;
    } catch (IOException e) {
      log.error("Failed to bootstrap workspace", e);
      throw new RuntimeException("Failed to bootstrap workspace: " + e.getMessage(), e);
    }
  }

  private void installAllTools(Executor.LifecycleContext ctx) {
    if (toolRegistry == null || toolRegistry.size() == 0) {
      log.debug("No tools registered in registry, skipping installation");
      return;
    }

    try {
      // Create execution context for installation
      ExecutionContext installContext = ExecutionContext.builder()
          .runId(ctx.runId())
          .environment(System.getenv())
          .variables(
              ctx.root() != null && ctx.root().body() != null
                  ? ctx.root().body().variables().get()
                  : Map.of())
          .build();

      log.info("Installing {} SPI-discovered tools", toolRegistry.size());
      toolRegistry.installAll(installContext);
      log.info("All tools installed successfully");
    } catch (Exception e) {
      log.error("Failed to install tools", e);
      throw new RuntimeException("Failed to install tools: " + e.getMessage(), e);
    }
  }
}
