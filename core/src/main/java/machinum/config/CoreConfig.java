package machinum.config;

import java.nio.file.Path;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;
import javax.script.ScriptEngineManager;
import lombok.Getter;
import lombok.RequiredArgsConstructor;
import machinum.checkpoint.CheckpointStore;
import machinum.checkpoint.FileCheckpointStore;
import machinum.compiler.CommonCompiler;
import machinum.compiler.EnvironmentLoader;
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
import machinum.manifest.ToolsBody.ToolRegistryType;
import machinum.pipeline.ErrorHandler;
import machinum.pipeline.ErrorHandler.ErrorHandlingConfig;
import machinum.pipeline.RunLogger;
import machinum.pipeline.runner.OneStepRunner;
import machinum.pipeline.runner.PipelineRunner;
import machinum.tool.BuiltInToolRegistry;
import machinum.tool.FileToolRegistry;
import machinum.tool.HttpToolRegistry;
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

  public BuiltInToolRegistry builtInToolRegistry(Path gradleProjectPath) {
    return singleton(() -> new BuiltInToolRegistry(gradleProjectPath).init());
  }

  public FileToolRegistry fileToolRegistry() {
    return singleton(FileToolRegistry::new);
  }

  public HttpToolRegistry httpToolRegistry(
      Path workspaceRoot, String baseUrl, String refreshStrategy) {
    return singleton(() -> new HttpToolRegistry(workspaceRoot, baseUrl, refreshStrategy).init());
  }

  public RunLogger runLogger(String runId) {
    return singleton(runId, () -> RunLogger.of(runId));
  }

  public ErrorHandler errorHandler() {
    return singleton(() -> new ErrorHandler(ErrorHandlingConfig.defaultConfig()));
  }

  public PipelineRunner oneStepRunner(RunLogger runLogger) {
    return singleton(() -> new OneStepRunner(
        runLogger,
        fileToolRegistry(),
        expressionResolver(),
        scriptRegistry(Path.of("./scripts")),
        errorHandler(),
        Map.of(),
        Map.of()));
  }

  public EnvironmentLoader environmentLoader() {
    var env = System.getenv().entrySet().stream()
        .filter(entry -> entry.getKey().toUpperCase().startsWith("MT_"))
        .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));
    return singleton(() -> new EnvironmentLoader(env));
  }

  public YamlManifestLoader yamlManifestLoader() {
    var yaml = yaml();
    var objectMapper = JsonMapper.builder().findAndAddModules().build();

    return singleton(() -> new YamlManifestLoader(objectMapper, yaml));
  }

  public Yaml yaml() {
    LoaderOptions loaderOptions = new LoaderOptions();
    loaderOptions.setMaxAliasesForCollections(50);
    loaderOptions.setAllowDuplicateKeys(false);
    SafeConstructor safeConstructor = new SafeConstructor(loaderOptions);
    Representer representer = new Representer(new DumperOptions());

    return singleton(() -> new Yaml(safeConstructor, representer));
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
        fileToolRegistry(),
        expressionResolver(),
        scriptRegistry(Path.of("./scripts")),
        toolsExecutor(ToolRegistryType.builtin)));
  }

  public ToolsExecutor toolsExecutor(ToolRegistryType type) {
    return singleton(ToolsExecutor::new);
  }

  public ExpressionResolver expressionResolver() {
    var engineManager = new ScriptEngineManager();
    Objects.requireNonNull(
        engineManager.getEngineByName("groovy"), "Groovy script engine not available");

    return singleton(() -> new DefaultExpressionResolver(engineManager));
  }

  // TODO: Use `tools/common/src/main/java/machinum/workspace/WorkspaceLayout.java` instead
  @Deprecated(forRemoval = true)
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
