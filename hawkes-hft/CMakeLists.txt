cmake_minimum_required(VERSION 3.24)
project(hawkes-hft CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

include(FetchContent)

FetchContent_Declare(
    databento
    GIT_REPOSITORY https://github.com/databento/databento-cpp
    GIT_TAG        main
)
FetchContent_MakeAvailable(databento)

FetchContent_Declare(
    Catch2
    GIT_REPOSITORY https://github.com/catchorg/Catch2.git
    GIT_TAG        v3.5.3
)
FetchContent_MakeAvailable(Catch2)

find_package(OpenSSL REQUIRED)
find_package(zstd    REQUIRED)

add_executable(hawkes-hft src/main.cpp)
target_include_directories(hawkes-hft PRIVATE src)
target_link_libraries(hawkes-hft PRIVATE databento::databento nlohmann_json::nlohmann_json)
target_compile_options(hawkes-hft PRIVATE -Wall -Wextra -O2)

enable_testing()

add_executable(tests
    tests/test_kinetic_queue.cpp
    tests/test_inventory_manager.cpp
)
target_include_directories(tests PRIVATE src)
target_link_libraries(tests PRIVATE Catch2::Catch2WithMain)
target_compile_options(tests PRIVATE -Wall -Wextra -O2)

include(CTest)
include(Catch)
catch_discover_tests(tests)
