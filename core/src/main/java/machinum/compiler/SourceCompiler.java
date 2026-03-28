package machinum.compiler;

import machinum.definition.SourceDefinition;
import machinum.manifest.SourceManifest;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.factory.Mappers;

@Mapper(uses = CommonCompiler.class)
public interface SourceCompiler extends YamlCompiler<SourceManifest, SourceDefinition> {

  SourceCompiler INSTANCE = Mappers.getMapper(SourceCompiler.class);

  @Mapping(target = "type", qualifiedByName = "compileConstant")
  @Mapping(target = "fileLocation", qualifiedByName = "compileString")
  @Mapping(target = "format", qualifiedByName = "compileConstant")
  @Mapping(target = "customLoader", qualifiedByName = "compileString")
  @Mapping(target = "variables", qualifiedByName = "compileMap")
  SourceDefinition compile(SourceManifest source, @Context CompilationContext ctx);
}
