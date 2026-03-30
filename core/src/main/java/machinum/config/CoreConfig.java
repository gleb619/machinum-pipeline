package machinum.config;

import java.nio.file.Path;
import java.util.Map;
import java.util.Objects;
import javax.script.ScriptEngineManager;
import lombok.Getter;
import lombok.RequiredArgsConstructor;
import machinum.checkpoint.CheckpointStore;
import machinum.checkpoint.FileCheckpointStore;
import machinum.compiler.CommonCompiler;
import machinum.compiler.ErrorHandlingCompiler;
import machinum.compiler.ItemsCompiler;
import machinum.compiler.PipelineConfigCompiler;
import machinum.compiler.PipelineManifestCompiler;
import machinum.compiler.RootManifestCompiler;
import machinum.compiler.SourceCompiler;
import machinum.compiler.StateCompiler;
import machinum.compiler.ToolCompiler;
import machinum.compiler.ToolsManifestCompiler;
import machinum.executor.Executor;
import machinum.executor.ToolsExecutor;
import machinum.executor.YamlManifestLoader;
import machinum.expression.DefaultExpressionResolver;
import machinum.expression.ExpressionResolver;
import machinum.expression.ScriptRegistry;
import machinum.pipeline.ErrorHandler;
import machinum.pipeline.RunLogger;
import machinum.pipeline.runner.OneStepRunner;
import machinum.pipeline.runner.PipelineRunner;
import machinum.tool.SpiToolRegistry;
import org.yaml.snakeyaml.DumperOptions;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;
import org.yaml.snakeyaml.representer.Representer;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

@Getter
@RequiredArgsConstructor
public class CoreConfig implements SingletonSupport {

  private final Scope scope;

  public static CoreConfig coreConfig() {
    return Holder.INSTANCE.coreConfig();
  }

  public static CoreConfig coreConfig(Scope scope) {
    return Holder.INSTANCE.coreConfig(scope);
  }

  public ObjectMapper objectMapper() {
    return singleton(() -> JsonMapper.builder().findAndAddModules().build());
  }

  public FileCheckpointStore fileCheckpointStore(Path baseDir) {
    return singleton(() -> new FileCheckpointStore(baseDir, objectMapper()));
  }

  public SpiToolRegistry spiToolRegistry() {
    return singleton(SpiToolRegistry::new);
  }

  public RunLogger runLogger(String runId) {
    return singleton(runId, () -> RunLogger.of(runId));
  }

  public ErrorHandler errorHandler() {
    return singleton(() -> new ErrorHandler(ErrorHandler.ErrorHandlingConfig.defaultConfig()));
  }

  public PipelineRunner oneStepRunner(RunLogger runLogger) {
    return singleton(() -> new OneStepRunner(
        runLogger,
        spiToolRegistry(),
        expressionResolver(),
        scriptRegistry(Path.of("./scripts")),
        errorHandler(),
        System.getenv(),
        Map.of()));
  }

  public YamlManifestLoader yamlManifestLoader() {
    LoaderOptions loaderOptions = new LoaderOptions();
    loaderOptions.setMaxAliasesForCollections(50);
    loaderOptions.setAllowDuplicateKeys(false);
    var yaml = new Yaml(new SafeConstructor(loaderOptions), new Representer(new DumperOptions()));
    var objectMapper = JsonMapper.builder().findAndAddModules().build();

    return singleton(() -> new YamlManifestLoader(objectMapper, yaml));
  }

  public CheckpointStore checkpointStore(Path checkpointDir) {
    return singleton(() -> fileCheckpointStore(checkpointDir));
  }

  public Executor executor() {
    return singleton(() -> new Executor(
        yamlManifestLoader(),
        rootManifestCompiler(),
        toolsManifestCompiler(),
        pipelineManifestCompiler(),
        errorHandler(),
        spiToolRegistry(),
        expressionResolver(),
        scriptRegistry(Path.of("./scripts")),
        toolsExecutor()));
  }

  public ToolsExecutor toolsExecutor() {
    return singleton(() -> new ToolsExecutor(spiToolRegistry()));
  }

  public ExpressionResolver expressionResolver() {
    var engineManager = new ScriptEngineManager();
    Objects.requireNonNull(
        engineManager.getEngineByName("groovy"), "Groovy script engine not available");

    return singleton(() -> new DefaultExpressionResolver(engineManager));
  }

  public ScriptRegistry scriptRegistry(Path scriptsDir) {
    return singleton(() -> new ScriptRegistry(scriptsDir).init());
  }

  public StateCompiler stateDefinitionCompiler() {
    return singleton(() -> StateCompiler.INSTANCE);
  }

  public PipelineManifestCompiler pipelineManifestCompiler() {
    return singleton(() -> PipelineManifestCompiler.INSTANCE);
  }

  public RootManifestCompiler rootManifestCompiler() {
    return singleton(() -> RootManifestCompiler.INSTANCE);
  }

  public ToolsManifestCompiler toolsManifestCompiler() {
    return singleton(() -> ToolsManifestCompiler.INSTANCE);
  }

  public PipelineConfigCompiler pipelineConfigDefinitionCompiler() {
    return singleton(() -> PipelineConfigCompiler.INSTANCE);
  }

  public SourceCompiler sourceDefinitionCompiler() {
    return singleton(() -> SourceCompiler.INSTANCE);
  }

  public ItemsCompiler itemsDefinitionCompiler() {
    return singleton(() -> ItemsCompiler.INSTANCE);
  }

  public ErrorHandlingCompiler errorHandlingDefinitionCompiler() {
    return singleton(() -> ErrorHandlingCompiler.INSTANCE);
  }

  public CommonCompiler commonCompiler() {
    return singleton(() -> CommonCompiler.INSTANCE);
  }

  public ToolCompiler toolCompiler() {
    return singleton(() -> ToolCompiler.INSTANCE);
  }

  @Getter
  private static final class Holder implements SingletonSupport {

    public static final Holder INSTANCE = new Holder();

    private final SingletonScope scope = SingletonScope.of();

    public CoreConfig coreConfig() {
      return coreConfig(SingletonScope.of());
    }

    public CoreConfig coreConfig(Scope scope) {
      return singleton(scope.id(), () -> new CoreConfig(scope));
    }
  }
}
