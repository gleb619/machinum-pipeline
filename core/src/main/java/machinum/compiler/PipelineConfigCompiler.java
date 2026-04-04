package machinum.compiler;

import machinum.definition.PipelineConfigDefinition;
import machinum.manifest.PipelineConfigManifest;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.factory.Mappers;

@Mapper(uses = CommonCompiler.class)
public interface PipelineConfigCompiler
    extends YamlCompiler<PipelineConfigManifest, PipelineConfigDefinition> {

  PipelineConfigCompiler INSTANCE = Mappers.getMapper(PipelineConfigCompiler.class);

  @Mapping(target = "batchSize", qualifiedByName = "compileConstant")
  @Mapping(target = "windowBatchSize", qualifiedByName = "compileConstant")
  @Mapping(target = "cooldown", qualifiedByName = "compileDuration")
  @Mapping(target = "allowOverrideMode", qualifiedByName = "compileConstant")
  PipelineConfigDefinition compile(PipelineConfigManifest source, @Context CompilationContext ctx);

}
