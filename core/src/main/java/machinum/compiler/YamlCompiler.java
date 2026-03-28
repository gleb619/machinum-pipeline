package machinum.compiler;

import org.mapstruct.Context;

public interface YamlCompiler<M, D> {

  D compile(M source, @Context CompilationContext ctx);
}
