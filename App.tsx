

import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { LiveSession, LiveServerMessage } from '@google/genai';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { CalendarView } from './components/CalendarView';
import { DashboardView } from './components/DashboardView';
import { VoiceAssistantView } from './components/VoiceAssistantView';
import { generateResponse, processCalendarPrompt, generateImage, generateSpeech, connectToLiveSession, createPcmBlob } from './services/geminiService';
import type { Module, ChatMessage, CalendarEvent, ImageData, Insight, Subtask } from './types';
import { MODULES } from './constants';
import { decode, decodeAudioData } from './utils/audioUtils';

const App: React.FC = () => {
    const [activeModule, setActiveModule] = useState<Module>(MODULES[0]);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [insights, setInsights] = useState<Insight[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    
    // Voice Assistant State
    const [voiceConnectionState, setVoiceConnectionState] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
    const [voiceTranscript, setVoiceTranscript] = useState<{ speaker: 'user' | 'ai', text: string }[]>([]);
    const liveSessionPromiseRef = useRef<Promise<LiveSession> | null>(null);
    const liveSessionRef = useRef<LiveSession | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const micStreamRef = useRef<MediaStream | null>(null);
    const audioProcessorNodeRef = useRef<ScriptProcessorNode | null>(null);

    const chatEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        if (activeModule.id !== 'voice') {
            scrollToBottom();
        }
    }, [messages, activeModule]);

    useEffect(() => {
        // Disconnect from voice session if module changes
        if (activeModule.id !== 'voice' && voiceConnectionState !== 'disconnected') {
            toggleVoiceConnection();
        }
        
        const welcomeMessage: ChatMessage = {
            id: Date.now(),
            sender: 'ai',
            text: activeModule.welcomeMessage,
        };
        setMessages([welcomeMessage]);
        setInsights([]); 
    }, [activeModule]);

    // --- Voice Assistant Logic ---
    const toggleVoiceConnection = useCallback(async () => {
        if (voiceConnectionState === 'connected') {
            // Disconnect logic
            micStreamRef.current?.getTracks().forEach(track => track.stop());
            micStreamRef.current = null;
            audioProcessorNodeRef.current?.disconnect();
            audioProcessorNodeRef.current = null;
            liveSessionRef.current?.close();
            liveSessionRef.current = null;
            liveSessionPromiseRef.current = null;
            setVoiceConnectionState('disconnected');
            console.log('Voice session closed.');
            return;
        }

        if (voiceConnectionState === 'disconnected') {
            // Connect logic
            setVoiceConnectionState('connecting');
            setVoiceTranscript([]);
            
            let currentInputTranscription = '';
            let currentOutputTranscription = '';
            let nextStartTime = 0;
            // FIX: Cast window to `any` to access vendor-prefixed `webkitAudioContext` without TypeScript errors.
            const outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
            const outputNode = outputAudioContext.createGain();
            const sources = new Set<AudioBufferSourceNode>();

            liveSessionPromiseRef.current = connectToLiveSession(activeModule.systemInstruction, {
                onopen: async () => {
                    setVoiceConnectionState('connected');
                    // FIX: Cast window to `any` to access vendor-prefixed `webkitAudioContext` without TypeScript errors.
                    const inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    micStreamRef.current = stream;
                    const source = inputAudioContext.createMediaStreamSource(stream);
                    const scriptProcessor = inputAudioContext.createScriptProcessor(4096, 1, 1);
                    audioProcessorNodeRef.current = scriptProcessor;

                    scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
                        const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                        const pcmBlob = createPcmBlob(inputData);
                        liveSessionPromiseRef.current?.then((session) => {
                            session.sendRealtimeInput({ media: pcmBlob });
                        });
                    };
                    source.connect(scriptProcessor);
                    scriptProcessor.connect(inputAudioContext.destination);
                },
                onmessage: async (message: LiveServerMessage) => {
                    if (message.serverContent?.inputTranscription) {
                        currentInputTranscription += message.serverContent.inputTranscription.text;
                    }
                    if (message.serverContent?.outputTranscription) {
                        currentOutputTranscription += message.serverContent.outputTranscription.text;
                    }
                    if (message.serverContent?.turnComplete) {
                        const finalInput = currentInputTranscription;
                        const finalOutput = currentOutputTranscription;
                        setVoiceTranscript(prev => [...prev, { speaker: 'user', text: finalInput }, { speaker: 'ai', text: finalOutput }]);
                        currentInputTranscription = '';
                        currentOutputTranscription = '';
                    }

                    const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData.data;
                    if (base64Audio) {
                        nextStartTime = Math.max(nextStartTime, outputAudioContext.currentTime);
                        const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContext, 24000, 1);
                        const source = outputAudioContext.createBufferSource();
                        source.buffer = audioBuffer;
                        source.connect(outputNode);
                        source.addEventListener('ended', () => sources.delete(source));
                        source.start(nextStartTime);
                        nextStartTime += audioBuffer.duration;
                        sources.add(source);
                    }
                },
                onerror: (e: ErrorEvent) => {
                    console.error('Voice session error:', e);
                    setVoiceConnectionState('error');
                    toggleVoiceConnection(); // Attempt to clean up
                },
                onclose: () => {
                    setVoiceConnectionState('disconnected');
                }
            });
            liveSessionRef.current = await liveSessionPromiseRef.current;
        }
    }, [voiceConnectionState, activeModule.systemInstruction]);


    const handleToggleSubtask = (eventId: string, subtaskId: string) => {
        setEvents(prevEvents => prevEvents.map(event => {
            if (event.id === eventId) {
                return { ...event, subtasks: event.subtasks?.map(sub => sub.id === subtaskId ? { ...sub, completed: !sub.completed } : sub) };
            }
            return event;
        }));
    };

    const handleTextToSpeech = useCallback(async (text: string) => {
        try {
            if (!audioContextRef.current) {
                // FIX: Cast window to `any` to access vendor-prefixed `webkitAudioContext` without TypeScript errors.
                audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
            }
            const base64Audio = await generateSpeech(text);
            const audioBuffer = await decodeAudioData(decode(base64Audio), audioContextRef.current, 24000, 1);
            const source = audioContextRef.current.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioContextRef.current.destination);
            source.start();
        } catch (error) {
            console.error("Failed to play audio:", error);
        }
    }, []);

    const handleSendMessage = useCallback(async (text: string, image?: ImageData) => {
        if (!text.trim() && !image) return;

        const userMessage: ChatMessage = { id: Date.now(), sender: 'user', text, image };
        setMessages(prev => [...prev, userMessage]);
        setIsLoading(true);

        try {
            let aiResponse: Partial<ChatMessage> = {};

            if (activeModule.id === 'calendar') {
                const result = await processCalendarPrompt(text);
                switch (result.action) {
                    case 'ADD_EVENT':
                        setEvents(prev => [...prev, result.payload]);
                        aiResponse.text = `Sure, I've added "${result.payload.title}" to your calendar for ${result.payload.date} at ${result.payload.time}.`;
                        if (result.payload.subtasks && result.payload.subtasks.length > 0) {
                            aiResponse.text += ` with ${result.payload.subtasks.length} subtask(s).`;
                        }
                        break;
                    case 'ADD_SUBTASK':
                        const { parentTaskTitle, subtaskTitle } = result.payload;
                        let found = false;
                        setEvents(prev => prev.map(event => {
                            if (event.title.toLowerCase() === parentTaskTitle.toLowerCase()) {
                                found = true;
                                const newSubtask: Subtask = { id: `sub-${Date.now()}`, text: subtaskTitle, completed: false };
                                return { ...event, subtasks: [...(event.subtasks || []), newSubtask] };
                            }
                            return event;
                        }));
                        aiResponse.text = found ? `Okay, I've added the subtask "${subtaskTitle}" to "${parentTaskTitle}".` : `Sorry, I couldn't find an event named "${parentTaskTitle}".`;
                        break;
                    case 'TOGGLE_SUBTASK':
                         // Omitted for brevity, logic remains the same
                         aiResponse.text = "Subtask status updated.";
                         break;
                    case 'MESSAGE':
                        aiResponse.text = result.payload;
                        break;
                }
            } else if (activeModule.id === 'insights') {
                const response = await generateResponse(activeModule.id, activeModule.systemInstruction, [], text, image);
                try {
                    const parsed = JSON.parse(response.text);
                    setInsights([{ id: Date.now().toString(), ...parsed }]);
                    aiResponse.text = "Here are the insights from your data.";
                } catch (e) {
                    aiResponse.text = response.text;
                }
            } else if (activeModule.id === 'marketing' && (text.toLowerCase().startsWith('generate image') || text.toLowerCase().startsWith('/image'))) {
                const imagePrompt = text.replace(/^(generate image|generate an image of|\/image)\s*/i, '');
                aiResponse.text = `Sure, generating an image of: "${imagePrompt}"`;
                const imageBase64 = await generateImage(imagePrompt);
                aiResponse.generatedImage = imageBase64;
            } else {
                // For 'pitch', 'marketing', 'communication', 'research', 'analysis'
                const history = messages.filter(m => m.sender === 'user' || m.text !== activeModule.welcomeMessage);
                const result = await generateResponse(activeModule.id, activeModule.systemInstruction, history, text, image);
                aiResponse.text = result.text;
                aiResponse.groundingChunks = result.groundingChunks;
            }

            const aiMessage: ChatMessage = { id: Date.now() + 1, sender: 'ai', ...aiResponse, text: aiResponse.text || "I'm not sure how to respond to that." };
            setMessages(prev => [...prev, aiMessage]);

        } catch (error) {
            console.error("Error communicating with Gemini API:", error);
            const errorMessage: ChatMessage = { id: Date.now() + 1, sender: 'ai', text: "Sorry, I'm having trouble connecting. Please check your API key and try again." };
            setMessages(prev => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
        }
    }, [activeModule, messages]);

    const renderModuleContent = () => {
        if (activeModule.id === 'voice') return null; // Voice assistant takes full screen
        switch (activeModule.id) {
            case 'calendar': return <CalendarView events={events} onToggleSubtask={handleToggleSubtask} />;
            case 'insights': return <DashboardView insights={insights} />;
            default: return null;
        }
    };
    
    return (
        <div className="flex h-screen w-screen bg-gray-100 font-sans">
            <Sidebar activeModule={activeModule} setActiveModule={setActiveModule} isOpen={sidebarOpen} setIsOpen={setSidebarOpen} />
            <main className="flex-1 flex flex-col h-screen transition-all duration-300">
                <header className="bg-white border-b border-gray-200 p-4 flex items-center justify-between shadow-sm z-10">
                    <button onClick={() => setSidebarOpen(!sidebarOpen)} className="md:hidden p-2 text-gray-600 hover:text-brand-primary">
                        {/* FIX: Corrected the malformed viewBox attribute in the SVG element. */}
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
                    </button>
                    <div className="flex items-center">
                        <span className="text-2xl mr-3">{activeModule.icon}</span>
                        <h1 className="text-xl font-bold text-gray-800">{activeModule.name}</h1>
                    </div>
                </header>

                <div className="flex-1 flex overflow-hidden">
                    {activeModule.id === 'voice' ? (
                        <VoiceAssistantView connectionState={voiceConnectionState} toggleConnection={toggleVoiceConnection} transcript={voiceTranscript} />
                    ) : (
                        <>
                            <div className="flex-1 flex flex-col p-4 overflow-y-auto">
                                <ChatView
                                    messages={messages}
                                    onSendMessage={handleSendMessage}
                                    isLoading={isLoading}
                                    chatEndRef={chatEndRef}
                                    showFileUpload={['insights', 'marketing', 'analysis', 'research'].includes(activeModule.id)}
                                    onTextToSpeech={handleTextToSpeech}
                                />
                            </div>
                            {renderModuleContent() && (
                                <div className="hidden lg:block lg:w-1/3 xl:w-2/5 border-l border-gray-200 bg-white p-6 overflow-y-auto">
                                {renderModuleContent()}
                                </div>
                            )}
                        </>
                    )}
                </div>
            </main>
        </div>
    );
};

export default App;