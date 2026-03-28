package machinum.compiler;

import java.util.Collections;
import machinum.definition.ToolsDefinition;
import machinum.definition.ToolsDefinition.ToolsBodyDefinition;
import machinum.manifest.ToolsManifest;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.Named;
import org.mapstruct.factory.Mappers;

@Mapper(uses = CommonCompiler.class)
public interface ToolsManifestCompiler extends YamlCompiler<ToolsManifest, ToolsDefinition> {

  ToolsManifestCompiler INSTANCE = Mappers.getMapper(ToolsManifestCompiler.class);

  @Mapping(target = "version", source = "version")
  @Mapping(target = "type", source = "type")
  @Mapping(target = "name", source = "name")
  @Mapping(target = "description", source = "description")
  @Mapping(target = "labels", source = "labels", qualifiedByName = "compileSimpleMap")
  @Mapping(target = "metadata", source = "metadata", qualifiedByName = "compileSimpleMap")
  @Mapping(target = "body", expression = "java(createToolsBody(source, ctx))")
  ToolsDefinition compile(ToolsManifest source, @Context CompilationContext ctx);

  @Named("createToolsBody")
  default ToolsBodyDefinition createToolsBody(
      ToolsManifest source, @Context CompilationContext ctx) {
    return new ToolsBodyDefinition(Collections.emptyList());
  }
}
