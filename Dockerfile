FROM gradle:8-jdk17 as build
WORKDIR /app
COPY build.gradle build.gradle
COPY settings.gradle settings.gradle
COPY src src
COPY server/admin-backend/conf conf
RUN gradle shadowJar

FROM eclipse-temurin:17-jdk
WORKDIR /app
COPY --from=build /app/build/libs/app-1.0.0-all.jar app.jar
COPY server/admin-backend/conf conf
EXPOSE 7070
CMD ["java", "-jar", "app.jar"]
