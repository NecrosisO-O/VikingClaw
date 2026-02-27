cmake_minimum_required(VERSION 3.12)
project(engine_tests)

include(CheckCXXCompilerFlag)
check_cxx_compiler_flag("-march=native" HAVE_MARCH_NATIVE)
if(HAVE_MARCH_NATIVE)
    add_compile_options(-march=native)
else()
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|amd64|AMD64")
        check_cxx_compiler_flag("-msse3" HAVE_SSE3)
        if(HAVE_SSE3)
            add_compile_options(-msse3)
        endif()
    endif()
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -g -Wno-error")

include_directories(${CMAKE_SOURCE_DIR}/../../src)
include_directories(${CMAKE_SOURCE_DIR}/../../third_party)
include_directories(${CMAKE_SOURCE_DIR}/../../third_party/leveldb-1.23/include)
include_directories(${CMAKE_SOURCE_DIR}/../../third_party/spdlog-1.14.1/include)

find_package(Threads REQUIRED)

# Build a local engine_impl for standalone tests/engine builds.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LEVELDB_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LEVELDB_BUILD_BENCHMARKS OFF CACHE BOOL "" FORCE)
set(LEVELDB_INSTALL OFF CACHE BOOL "" FORCE)
add_subdirectory(../../third_party/leveldb-1.23 ${CMAKE_BINARY_DIR}/leveldb_build)

file(GLOB_RECURSE ENGINE_SOURCES
    "${CMAKE_SOURCE_DIR}/../../src/index/*.cpp"
    "${CMAKE_SOURCE_DIR}/../../src/store/*.cpp"
    "${CMAKE_SOURCE_DIR}/../../src/common/*.cpp"
)

add_library(engine_impl STATIC
    ${ENGINE_SOURCES}
)

target_compile_options(engine_impl PRIVATE -fPIC)
target_link_libraries(engine_impl PRIVATE
    Threads::Threads
    leveldb
)

add_executable(test_common
    test_common.cpp
    ${CMAKE_SOURCE_DIR}/../../src/common/log_utils.cpp
)

target_link_libraries(test_common PRIVATE
    Threads::Threads
)

add_executable(test_index_engine
    test_index_engine.cpp
)

target_link_libraries(test_index_engine PRIVATE
    engine_impl
    Threads::Threads
)
