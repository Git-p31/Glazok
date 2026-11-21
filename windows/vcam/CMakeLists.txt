cmake_minimum_required(VERSION 3.20)
project(GlazokVCam CXX)

set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")   # без зависимости от VC++ Redistributable
add_compile_definitions(UNICODE _UNICODE)
add_compile_options(/utf-8)

# DirectShow BaseClasses (Microsoft, MIT) — см. baseclasses/LICENSE
file(GLOB BASECLASSES_SRC baseclasses/*.cpp)
add_library(strmbase STATIC ${BASECLASSES_SRC})
target_include_directories(strmbase PUBLIC baseclasses)
target_compile_options(strmbase PRIVATE /W0 /wd4996)
target_compile_definitions(strmbase PUBLIC $<$<NOT:$<CONFIG:Debug>>:NDEBUG>)

add_library(GlazokVCam SHARED vcam.cpp vcam.def)
target_link_libraries(GlazokVCam PRIVATE strmbase strmiids winmm ole32 oleaut32 uuid gdi32 user32 advapi32)
set_target_properties(GlazokVCam PROPERTIES OUTPUT_NAME "GlazokVCam")

add_executable(glazok-testpattern tools/testpattern.cpp)
add_executable(glazok-grab tools/grab.cpp)
target_link_libraries(glazok-grab PRIVATE strmiids ole32 oleaut32 uuid)
