
CFLAGS=-std=c++14

marchingsquares: marchingsquares.cpp
	g++ $(CFLAGS) -g -O0 -DEXECUTABLE marchingsquares.cpp -o marchingsquares.exe

marchingsquares.o: marchingsquares.cpp
	em++ $(CFLAGS) -O2 -DWASM -c marchingsquares.cpp -o marchingsquares.o

marchingsquares.js: marchingsquares.o
	em++ -lembind marchingsquares.o -o marchingsquares.js -sENVIRONMENT=web -sMODULARIZE=1 -sALLOW_MEMORY_GROWTH -sNO_DISABLE_EXCEPTION_CATCHING --embind-emit-tsd marchingsquares_embind.d.ts

exe: marchingsquares
lib: marchingsquares.js
all: lib
clean:
	rm marchingsquares marchingsquares_embind.d.ts marchingsquares.o marchingsquares.wasm