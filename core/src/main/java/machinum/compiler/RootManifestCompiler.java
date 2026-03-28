package machinum.compiler;

import java.util.HashMap;
import machinum.definition.RootDefinition;
import machinum.definition.RootDefinition.RootBodyDefinition;
import machinum.expression.ExpressionContext;
import machinum.manifest.RootManifest;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.Named;
import org.mapstruct.factory.Mappers;

@Mapper(uses = CommonCompiler.class)
public interface RootManifestCompiler extends YamlCompiler<RootManifest, RootDefinition> {

  RootManifestCompiler INSTANCE = Mappers.getMapper(RootManifestCompiler.class);

  @Mapping(target = "version", source = "version")
  @Mapping(target = "type", source = "type")
  @Mapping(target = "name", source = "name")
  @Mapping(target = "description", source = "description")
  @Mapping(target = "labels", source = "labels", qualifiedByName = "compileSimpleMap")
  @Mapping(target = "metadata", source = "metadata", qualifiedByName = "compileSimpleMap")
  @Mapping(target = "body", source = "source", qualifiedByName = "createRootBody")
  RootDefinition compile(RootManifest source, @Context CompilationContext ctx);

  @Named("createRootBody")
  default RootBodyDefinition createRootBody(RootManifest source, @Context CompilationContext ctx) {
    ExpressionContext exprCtx = CommonCompiler.INSTANCE.createExpressionContext(ctx);
    CompiledMap pipelineConfig = CompiledMap.of(new HashMap<>(), exprCtx, ctx.getResolver());
    CompiledMap env = CommonCompiler.INSTANCE.compileMap(source.body().env(), ctx);
    return new RootBodyDefinition(pipelineConfig, env);
  }
}
