"use client";

import {
  CreateProjectKeyResponse,
  LiveClient,
  LiveTranscriptionEvents,
  createClient,
} from "@deepgram/sdk";
import { useState, useEffect, useCallback, use } from "react";
import { useQueue } from "@uidotdev/usehooks";
import Dg from "./dg.svg";
import Recording from "./recording.svg";
import Image from "next/image";
import axios from "axios";
import Siriwave from 'react-siriwave';

import ChatGroq from "groq-sdk";


export default function Microphone() {
  const { add, remove, first, size, queue } = useQueue<any>([]);
  const [apiKey, setApiKey] = useState<CreateProjectKeyResponse | null>();
  const [neetsApiKey, setNeetsApiKey] = useState<string | null>();
  const [groqClient, setGroqClient] = useState<ChatGroq>();
  const [connection, setConnection] = useState<LiveClient | null>();
  const [isListening, setListening] = useState(false);
  const [isLoadingKey, setLoadingKey] = useState(true);
  const [isLoading, setLoading] = useState(true);
  const [isProcessing, setProcessing] = useState(false);
  const [micOpen, setMicOpen] = useState(false);
  const [microphone, setMicrophone] = useState<MediaRecorder | null>();
  const [userMedia, setUserMedia] = useState<MediaStream | null>();
  const [caption, setCaption] = useState<string | null>();
  const [audio, setAudio] = useState<HTMLAudioElement | null>();
  const [chatLogs, setChatLogs] = useState<{ role: string; content: string; timestamp: Date }[]>([]);
  const [isSpeaking, setSpeaking] = useState(false);

  const toggleMicrophone = useCallback(async () => {
    if (microphone && userMedia) {
      setUserMedia(null);
      setMicrophone(null);

      microphone.stop();
    } else {
      const userMedia = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      const microphone = new MediaRecorder(userMedia);
      microphone.start(500);

      microphone.onstart = () => {
        setMicOpen(true);
      };

      microphone.onstop = () => {
        setMicOpen(false);
      };

      microphone.ondataavailable = (e) => {
        add(e.data);
      };

      setUserMedia(userMedia);
      setMicrophone(microphone);
    }
  }, [add, microphone, userMedia]);

  useEffect(() => {
    if (!groqClient) {
      console.log("getting a new groqClient");
      fetch("/api/groq", { cache: "no-store" })
        .then((res) => res.json())
        .then((object) => {
          const groq = new ChatGroq({ apiKey: object.apiKey, dangerouslyAllowBrowser: true});

          setGroqClient(groq);
          setLoadingKey(false);
        })
        .catch((e) => {
          console.error(e);
        });
      
    }
  }, [groqClient]);

  useEffect(() => {
    if (!neetsApiKey) {
      console.log("getting a new neets api key");
      fetch("/api/neets", { cache: "no-store" })
        .then((res) => res.json())
        .then((object) => {
          if (!("apiKey" in object)) throw new Error("No api key returned");

          setNeetsApiKey(object.apiKey);
          setLoadingKey(false);
        })
        .catch((e) => {
          console.error(e);
        });
    }
  }, [neetsApiKey]);

  useEffect(() => {
    if (!apiKey) {
      console.log("getting a new api key");
      fetch("/api", { cache: "no-store" })
        .then((res) => res.json())
        .then((object) => {
          if (!("key" in object)) throw new Error("No api key returned");

          setApiKey(object);
          setLoadingKey(false);
        })
        .catch((e) => {
          console.error(e);
        });
    }
  }, [apiKey]);

  useEffect(() => {
    if (isSpeaking) return;
    
    if (apiKey && "key" in apiKey) {
      console.log("connecting to deepgram");
      const deepgram = createClient(apiKey?.key ?? "");
      const connection = deepgram.listen.live({
        model: "nova-2",
        interim_results: false,
        language: "en-US",
        smart_format: true
      });

      connection.on(LiveTranscriptionEvents.Open, () => {
        console.log("connection established");
        setListening(true);
      });

      connection.on(LiveTranscriptionEvents.Close, () => {
        console.log("connection closed");
        setListening(false);
        setApiKey(null);
        setConnection(null);
      });

      connection.on(LiveTranscriptionEvents.Transcript, async (data)=> {
        setSpeaking(true);
        const words = data.channel.alternatives[0].words;
        
        const caption = words
          .map((word: any) => word.punctuated_word ?? word.word)
          .join(" ");
        
        if (caption !== "") {
          setCaption(caption);
          console.log(caption);
          if (data.speech_final) {   
            // Store the speaker's transcription in the chat logs
            setChatLogs((prevLogs) => [
              ...prevLogs,
              { role: "user", content: caption, timestamp: new Date() },
            ]);         
            if (groqClient) {
              const stream = await groqClient.chat.completions.create({
                messages: [
                  {
                    role: "system",
                    content: "You are communicating with the user on a phone, so your answers should not be too long and go directly to the essence of the sentences.",
                  },
                  {
                    role: "user",
                    content: caption,
                  },
                ],
                model: "mixtral-8x7b-32768",
                stream: true,
                temperature: 0.5,
                top_p: 1,
                max_tokens: 1024
              });
            
              let accumulator = "";
              const audioQueue = [];
              let isPlayingAudio = false;
            
              const playNextAudio = () => {
                if (audioQueue.length > 0 && !isPlayingAudio) {
                  isPlayingAudio = true;
                  const audio = audioQueue.shift();
                  audio.play();
                  audio.onended = () => {
                    isPlayingAudio = false;
                    playNextAudio();
                  };
                }
              };
            
              for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta?.content || "";
                accumulator += delta;
                setCaption(accumulator);
            
                // Split the accumulated response based on sentence boundaries
                const sentences = accumulator.match(/[^.!?]+[.!?]+/g) || [];
            
                if (sentences.length > 1) {
                  for (const sentence of sentences.slice(0, -1)) {
                    console.log('sentence: ', sentence);
            
                    if (neetsApiKey) {
                      try {
                        const response = await axios.post(
                          "https://api.neets.ai/v1/tts",
                          {
                            text: sentence,
                            voice_id: "vits-eng-40",
                            params: {
                              model: "vits",
                            },
                          },
                          {
                            headers: {
                              "Content-Type": "application/json",
                              "X-API-Key": neetsApiKey,
                            },
                            responseType: "arraybuffer",
                          }
                        );
            
                        const blob = new Blob([response.data], { type: "audio/mp3" });
                        const url = URL.createObjectURL(blob);
                        const audio = new Audio(url);
                        audioQueue.push(audio);
                        playNextAudio();
                      } catch (error) {
                        console.error(error);
                      }
                    }
                  }
            
                  // Update the accumulator with the remaining incomplete sentence
                  accumulator = sentences[sentences.length - 1];
                }
              }
            
              // Process the remaining incomplete sentence, if any
              if (accumulator.trim() !== "" && neetsApiKey) {
                try {
                  console.log('sentence: ', accumulator);
                  const response = await axios.post(
                    "https://api.neets.ai/v1/tts",
                    {
                      text: accumulator,
                      voice_id: "vits-eng-40",
                      params: {
                        model: "vits",
                      },
                    },
                    {
                      headers: {
                        "Content-Type": "application/json",
                        "X-API-Key": neetsApiKey,
                      },
                      responseType: "arraybuffer",
                    }
                  );
            
                  const blob = new Blob([response.data], { type: "audio/mp3" });
                  const url = URL.createObjectURL(blob);
                  const audio = new Audio(url);
                  audioQueue.push(audio);
                  playNextAudio();
                } catch (error) {
                  console.error(error);
                }
              }
            
              // Store the assistant's transcription in the chat logs
              setChatLogs((prevLogs) => [
                ...prevLogs,
                {
                  role: "assistant",
                  content: accumulator,
                  timestamp: new Date(),
                },
              ]);
            }
          }
        }
      });

      setConnection(connection);
      setLoading(false);
    }
  }, [apiKey, isSpeaking]);

  useEffect(() => {
    const processQueue = async () => {
      if (size > 0 && !isProcessing) {
        setProcessing(true);

        // if (isSpeaking) {
        //   remove();
        //   setSpeaking(false);
        // }

        if (isListening) {
          const blob = first;
          connection?.send(blob);
          remove();
        }

        const waiting = setTimeout(() => {
          clearTimeout(waiting);
          setProcessing(false);
        }, 250);
      }
    };

    processQueue();
  }, [connection, queue, remove, first, size, isProcessing, isListening, isSpeaking]);

  function handleAudio() {
    return audio && audio.currentTime > 0 && !audio.paused && !audio.ended && audio.readyState > 2;
  }

  if (isLoadingKey)
    return (
      <span className="w-full text-center">Loading temporary API key...</span>
    );
  if (isLoading)
    return <span className="w-full text-center">Loading the app...</span>;

  return (
    <div className="w-full relative">
      <div className="relative flex w-screen flex justify-center items-center max-w-screen-lg place-items-center content-center before:pointer-events-none after:pointer-events-none before:absolute before:right-0 after:right-1/4 before:h-[300px] before:w-[480px] before:-translate-x-1/2 before:rounded-full before:bg-gradient-radial before:from-white before:to-transparent before:blur-2xl before:content-[''] after:absolute after:-z-20 after:h-[180px] after:w-[240px] after:translate-x-1/3 after:bg-gradient-conic after:from-sky-200 after:via-blue-200 after:blur-2xl after:content-[''] before:dark:bg-gradient-to-br before:dark:from-transparent before:dark:to-blue-700 before:dark:opacity-10 after:dark:from-sky-900 after:dark:via-[#0141ff] after:dark:opacity-40 before:lg:h-[360px]">
      <Siriwave
        color="#6adc92"
        autostart={handleAudio() || false}
       />
      </div>
      <div className="mt-10 flex flex-col align-middle items-center">
        <button className="w-24 h-24" onClick={() => toggleMicrophone()}>
          <Recording
            width="96"
            height="96"
            className={
              `cursor-pointer` + !!userMedia && !!microphone && micOpen
                ? "fill-red-400 drop-shadow-glowRed"
                : "fill-gray-600"
            }
          />
        </button>
        <div className="mt-20 p-6 text-xl text-center">
          {caption}
        </div>
      </div>
      
    </div>
  );
}
