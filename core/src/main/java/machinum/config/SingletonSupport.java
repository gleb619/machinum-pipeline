package machinum.config;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
import org.apache.commons.lang3.exception.ExceptionUtils;

public interface SingletonSupport {

  Scope getScope();

  default <T> T singleton(Factory<T> factory) {
    return getScope().get(factory);
  }

  default <T> T singleton(String hash, Factory<T> factory) {
    return getScope().get(hash, factory);
  }

  @FunctionalInterface
  interface Factory<T> extends Supplier<T> {

    default Kind kind() {
      return new Kind(getClass().getName());
    }

    static <U> Factory<U> from(String hash, Supplier<U> factory) {
      var name = factory.getClass().getName();
      var kind = new Kind("%s@%s".formatted(name, hash));
      return new HashFactory<>(factory, kind);
    }
  }

  record HashFactory<U>(Supplier<U> factory, Kind kind) implements Factory<U> {

    @Override
    public U get() {
      return factory.get();
    }
  }

  @FunctionalInterface
  interface Scope {

    <T> T get(Factory<T> factory);

    default <T> T get(String hash, Supplier<T> factory) {
      return get(Factory.from(hash, factory));
    }

    default String id() {
      throw new IllegalStateException("Not implemented!");
    }
  }

  record Kind(String name) {}

  record SingletonScope(String id, Map<Kind, Object> instances) implements Scope {

    public static SingletonScope of() {
      return new SingletonScope(UUID.randomUUID().toString(), new ConcurrentHashMap<>());
    }

    @Override
    @SuppressWarnings("unchecked")
    public <T> T get(Factory<T> factory) {
      try {
        return (T) instances.computeIfAbsent(factory.kind(), _ -> factory.get());
      } catch (IllegalStateException e) {
        if ("recursive update".equalsIgnoreCase(e.getMessage())) {
          return onLameWay(factory);
        } else {
          return ExceptionUtils.rethrow(e);
        }
      }
    }

    private <T> T onLameWay(Factory<T> factory) {
      Object instance = instances.get(factory.kind());
      if (instance != null) {
        return (T) instance;
      }

      synchronized (instances) {
        instance = instances.get(factory.kind());
        if (instance != null) {
          return (T) instance;
        }

        T created = factory.get();
        instances.putIfAbsent(factory.kind(), created);
        return created;
      }
    }
  }
}
