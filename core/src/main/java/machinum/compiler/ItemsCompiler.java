package machinum.compiler;

import machinum.definition.ItemsDefinition;
import machinum.manifest.ItemsManifest;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.factory.Mappers;

@Mapper(uses = CommonCompiler.class)
public interface ItemsCompiler extends YamlCompiler<ItemsManifest, ItemsDefinition> {

  ItemsCompiler INSTANCE = Mappers.getMapper(ItemsCompiler.class);

  @Mapping(target = "type", qualifiedByName = "compileConstant")
  @Mapping(target = "customExtractor", qualifiedByName = "compileString")
  @Mapping(target = "variables", qualifiedByName = "compileMap")
  ItemsDefinition compile(ItemsManifest items, @Context CompilationContext ctx);
}
