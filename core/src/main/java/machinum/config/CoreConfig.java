package machinum.config;

import java.nio.file.Path;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
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
import machinum.executor.YamlManifestLoader;
import machinum.expression.DefaultExpressionResolver;
import machinum.expression.ExpressionResolver;
import machinum.expression.ScriptRegistry;
import machinum.manifest.PipelineManifest;
import machinum.pipeline.EnvironmentLoader;
import machinum.pipeline.PipelineStateMachine;
import machinum.pipeline.RunLogger;
import machinum.pipeline.RuntimeConfigLoader;
import machinum.pipeline.runner.OneStepRunner;
import machinum.pipeline.runner.StateProcessor;
import machinum.pipeline.runner.StateRunner;
import machinum.tool.InMemoryToolRegistry;
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

  public InMemoryToolRegistry inMemoryToolRegistry() {
    return singleton(InMemoryToolRegistry::new);
  }

  public RunLogger runLogger(String runId) {
    return singleton(runId, () -> RunLogger.of(runId));
  }

  public StateProcessor stateProcessor(RunLogger runLogger) {
    return singleton(() -> new StateProcessor(
        inMemoryToolRegistry(),
        runLogger,
        expressionResolver(),
        scriptRegistry(Path.of("./scripts")),
        System.getenv(),
        Map.of()));
  }

  public StateRunner stateRunner(RunLogger runLogger) {
    return singleton(() -> new OneStepRunner(
        runLogger,
        stateProcessor(runLogger),
        expressionResolver(),
        scriptRegistry(Path.of("./scripts")),
        System.getenv(),
        Map.of()));
  }

  // TODO: Use bean or remove it
  @Deprecated(forRemoval = true)
  public EnvironmentLoader environmentLoader() {
    // TODO: possible problem with env disclosure
    return singleton(() -> new EnvironmentLoader(System.getenv()));
  }

  public YamlManifestLoader yamlManifestLoader() {
    LoaderOptions loaderOptions = new LoaderOptions();
    loaderOptions.setMaxAliasesForCollections(50);
    loaderOptions.setAllowDuplicateKeys(false);
    var yaml = new Yaml(new SafeConstructor(loaderOptions), new Representer(new DumperOptions()));
    var objectMapper = JsonMapper.builder().findAndAddModules().build();

    return singleton(() -> new YamlManifestLoader(objectMapper, yaml));
  }

  public RuntimeConfigLoader runtimeConfigLoader() {
    return singleton(() -> new RuntimeConfigLoader(yamlManifestLoader()));
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
        scriptRegistry(Path.of("./scripts"))));
  }

  public PipelineStateMachine pipelineStateMachine(Path checkpointDir, PipelineManifest pipeline) {
    return pipelineStateMachine(UUID.randomUUID().toString(), checkpointDir, pipeline);
  }

  public PipelineStateMachine pipelineStateMachine(
      String runId, Path checkpointDir, PipelineManifest pipeline) {
    var runLogger = runLogger(runId);
    return singleton(() -> PipelineStateMachine.builder()
        .runId(runId)
        .pipeline(pipeline)
        .toolRegistry(inMemoryToolRegistry())
        .checkpointStore(checkpointStore(checkpointDir))
        .runLogger(runLogger)
        .stateRunner(stateRunner(runLogger))
        .expressionResolver(expressionResolver())
        .build());
  }

  // TODO: Use bean or remove it
  @Deprecated(forRemoval = true)
  public StateProcessor stateProcessor(String runId) {
    RunLogger runLogger = runLogger(runId);
    return singleton(() -> stateProcessor(runLogger));
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
