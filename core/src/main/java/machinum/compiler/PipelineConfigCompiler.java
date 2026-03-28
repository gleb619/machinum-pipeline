package machinum.compiler;

import machinum.definition.PipelineConfigDefinition;
import machinum.definition.PipelineExecutionDefinition;
import machinum.manifest.PipelineConfigManifest;
import machinum.manifest.PipelineConfigManifest.PipelineExecution;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.Named;
import org.mapstruct.factory.Mappers;

@Mapper(uses = CommonCompiler.class)
public interface PipelineConfigCompiler
    extends YamlCompiler<PipelineConfigManifest, PipelineConfigDefinition> {

  PipelineConfigCompiler INSTANCE = Mappers.getMapper(PipelineConfigCompiler.class);

  @Mapping(target = "batchSize", qualifiedByName = "compileConstant")
  @Mapping(target = "windowBatchSize", qualifiedByName = "compileConstant")
  @Mapping(target = "cooldown", qualifiedByName = "compileString")
  @Mapping(target = "allowOverrideMode", qualifiedByName = "compileConstant")
  @Mapping(target = "execution", qualifiedByName = "compileExecution")
  PipelineConfigDefinition compile(PipelineConfigManifest source, @Context CompilationContext ctx);

  @Named("compileExecution")
  default PipelineExecutionDefinition compileExecution(
      PipelineExecution execution, @Context CompilationContext ctx) {
    if (execution == null) {
      throw new IllegalArgumentException("Execution can't be null");
    }
    PipelineConfigManifest.ManifestSnapshotConfig snapshot = execution.manifestSnapshot();
    Compiled<Boolean> enabled = CommonCompiler.INSTANCE.compileConstant(snapshot.enabled());
    Compiled<String> mode = CommonCompiler.INSTANCE.compileString(snapshot.mode(), ctx);
    Compiled<String> modeValue = CommonCompiler.INSTANCE.compileString(execution.mode(), ctx);
    Compiled<Integer> maxConcurrency =
        CommonCompiler.INSTANCE.compileConstant(execution.maxConcurrency());
    return new PipelineExecutionDefinition(enabled, mode, modeValue, maxConcurrency);
  }
}
