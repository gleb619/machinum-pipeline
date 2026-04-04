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
import machinum.compiler.EnvironmentLoader;
import machinum.compiler.PipelineManifestCompiler;
import machinum.compiler.RootManifestCompiler;
import machinum.compiler.ToolsManifestCompiler;
import machinum.definition.PipelineDefinition.ItemsDefinition;
import machinum.definition.PipelineDefinition.SourceDefinition;
import machinum.executor.Executor;
import machinum.executor.ToolsExecutor;
import machinum.executor.YamlManifestLoader;
import machinum.expression.DefaultExpressionResolver;
import machinum.expression.ExpressionResolver;
import machinum.expression.ScriptRegistry;
import machinum.manifest.ToolsBody.ToolRegistryType;
import machinum.pipeline.ErrorStrategyResolver;
import machinum.pipeline.RunLogger;
import machinum.pipeline.runner.OneStepRunner;
import machinum.pipeline.runner.PipelineRunner;
import machinum.streamer.FileSourceStreamer;
import machinum.streamer.HttpSourceStreamer;
import machinum.streamer.JsonlSourceStreamer;
import machinum.streamer.MdFileItemsStreamer;
import machinum.streamer.SampleSourceStreamer;
import machinum.streamer.SourceUriParser;
import machinum.streamer.Streamer;
import machinum.streamer.VoidSourceStreamer;
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

  public BuiltInToolRegistry builtInToolRegistry() {
    return singleton(() -> new BuiltInToolRegistry().init());
  }

  public FileToolRegistry fileToolRegistry(Path workspaceRoot) {
    return singleton(() -> new FileToolRegistry(workspaceRoot).init());
  }

  public HttpToolRegistry httpToolRegistry(
      Path workspaceRoot, String baseUrl, String refreshStrategy) {
    return singleton(() -> new HttpToolRegistry(workspaceRoot, baseUrl, refreshStrategy).init());
  }

  //TODO: Replace code at `core/src/main/java/machinum/executor/PipelineExecutor.java`, we need to use `CoreConfig`
  //  // instead of static creation
  @Deprecated
  public RunLogger runLogger(String runId) {
    return singleton(runId, () -> RunLogger.of(runId));
  }

  public ErrorStrategyResolver errorStrategyResolver() {
    return singleton(ErrorStrategyResolver::new);
  }

  //TODO: replace code at `core/src/main/java/machinum/executor/PipelineExecutor.java`, we need to use `CoreConfig`
  // instead of contructor creation
  @Deprecated
  public PipelineRunner oneStepRunner(Path workspaceRoot, RunLogger runLogger) {
    return singleton(() -> new OneStepRunner(
        runLogger,
        fileToolRegistry(workspaceRoot),
        expressionResolver(),
        scriptRegistry(Path.of("./scripts")),
        errorStrategyResolver(),
        null,
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

  public Executor executor(Path workspaceRoot) {
    return singleton(() -> new Executor(
        yamlManifestLoader(),
        rootManifestCompiler(),
        toolsManifestCompiler(),
        pipelineManifestCompiler(),
        errorStrategyResolver(),
        builtInToolRegistry(),
        expressionResolver(),
        scriptRegistry(Path.of("./scripts")),
        toolsExecutor(ToolRegistryType.builtin),
        objectMapper()));
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

  public PipelineManifestCompiler pipelineManifestCompiler() {
    return singleton(() -> PipelineManifestCompiler.INSTANCE);
  }

  public RootManifestCompiler rootManifestCompiler() {
    return singleton(() -> RootManifestCompiler.INSTANCE);
  }

  public ToolsManifestCompiler toolsManifestCompiler() {
    return singleton(() -> ToolsManifestCompiler.INSTANCE);
  }

  private static final int DEFAULT_BATCH_SIZE = 10;

  public Streamer sourceStreamer(SourceDefinition source) {
    String uri = source.uri() != null ? source.uri().get() : null;
    if (uri == null || uri.isBlank()) {
      throw new IllegalArgumentException("Source URI cannot be empty");
    }

    SourceUriParser.ParsedSourceUri parsed = SourceUriParser.parse(uri);

    return switch (parsed.type()) {
      case VOID -> new VoidSourceStreamer();
      case SAMPLES -> new SampleSourceStreamer(source, DEFAULT_BATCH_SIZE);
      case FILE -> {
        //TODO: redo, just check extension, work on *.jsonl
        String format = parsed.getQueryParam("format", "folder");
        if ("jsonl".equals(format)) {
          yield new JsonlSourceStreamer(source, objectMapper(), DEFAULT_BATCH_SIZE);
        }
        yield new FileSourceStreamer(source, DEFAULT_BATCH_SIZE);
      }
      case HTTP -> new HttpSourceStreamer(source, objectMapper(), DEFAULT_BATCH_SIZE);
      case SCRIPT ->
        throw new IllegalArgumentException("Custom script loaders not yet supported. URI: " + uri);
    };
  }

  public Streamer itemsStreamer(ItemsDefinition items) {
    return new MdFileItemsStreamer(items, DEFAULT_BATCH_SIZE);
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
