const basePrompt = {
  "GLOBAL_IDENTITY_LOCK": "IDENTITY IS EXTERNALLY ANCHORED VIA MASTER ANCHOR IMAGE (ANCHOR A).\nDO NOT GENERATE, INFER, MODIFY, OR REPLACE CORE IDENTITY.\nFACIAL STRUCTURE, BONE GEOMETRY, AND BODY PROPORTIONS MUST MATCH ANCHOR A EXACTLY.",
  "TEMPORARY_IDENTITY_OVERRIDE": {
    "scope": "styling-only",
    "allowed_changes": [
      "hair parting"
    ],
    "constraints": "override applies ONLY to hair parting configuration; facial structure, hair density, hairline, and overall identity remain unchanged",
    "revert_instruction": "remove this block to restore full global identity lock"
  },
  "identity_constraints": {
    "integrity": "Keep the same woman exactly as the reference image. Do not change face, body, or identity.",
    "facial_structure": "Preserve exact facial bone structure and proportions.",
    "prohibitions": [
      "no identity drift",
      "no reshaping"
    ]
  },
  "skin_and_micro_details": {
    "texture": "visible pores and natural skin grain on face and body",
    "freckles": "freckles across nose and cheeks preserved",
    "glow": "natural skin glow under bright indoor lighting, not airbrushed",
    "lips": "naturally full lips with visible lip texture and hydration lines, soft glossy finish",
    "eyes": "sharp eyes with realistic wetline, iris detail, and crisp catchlights",
    "processing": "no smoothing, no beauty filters, no plastic skin"
  },
  "environment": {
    "location": "modern kitchen interior",
    "time": "evening or indoor night ambience",
    "kitchen_details": [
      "sleek modern cabinetry",
      "clean stone countertop",
      "subtle under-cabinet lighting",
      "minimal clutter"
    ],
    "background_rule": "kitchen remains readable and realistic, no artificial blur"
  },
  "wardrobe": {
    "override_rule": "replace all reference clothing completely",
    "top": "cropped lightweight thin-string white vest top",
    "bottoms": "Nike athletic gym shorts with elastic waistband and subtle logo placement",
    "fit_logic": "clothing conforms naturally to the body with no compression, reshaping, or proportion changes"
  },
  "accessories_and_grooming": {
    "jewelry": "none unless already present in anchor image",
    "nails": "natural or subtle manicure only, no exaggerated styling unless present in anchor image",
    "hair": {
      "style": "straight hair",
      "parting": "strict middle parting, perfectly centered and symmetrical",
      "bangs": "none",
      "ear_coverage": "both ears fully covered by hair at all times",
      "placement": "hair must fall forward in front of the ears on both sides, resting over the cheeks and jawline",
      "constraints": [
        "absolutely no hair tucked behind ears",
        "no ear exposure",
        "no side sweep",
        "no off-center bias",
        "no asymmetry artifacts"
      ]
    }
  },
  "pose_and_expression": {
    "pose": "POV front-facing selfie",
    "seating_surface": "subject sitting on top of the kitchen countertop",
    "leg_positioning": "legs bent naturally over the edge of the counter, relaxed and casual",
    "arm_configuration": {
      "extended_arm": "ONE arm extended high and forward but angled outward to the side, elbow slightly bent, phone held above eye-line yet forward from the head, with the entire hand and forearm kept fully out of frame",
      "hand_visibility_rule": "no hand, no fingers, no wrist, no forearm visible anywhere in frame",
      "free_arm": "the other arm bent naturally with the hand resting gently on the upper chest"
    },
    "body_position": "upright seated posture with a subtle torso twist creating asymmetry",
    "head_angle": "head tilted slightly to one side, not square to camera",
    "expression": "candid, natural, lightly confident expression",
    "framing": "tight upper-body selfie framing; crop starts below collarbones and ends above head with reduced headroom"
  },
  "camera_and_lighting": {
    "camera_style": "candid phone-camera realism",
    "camera": {
      "type": "front-facing smartphone camera",
      "angle": "high downward angle from extended arm POV",
      "placement_logic": "camera held forward and slightly to the subject’s right, not overhead",
      "rotation": "camera rotated clockwise approximately 10–15 degrees to create a clear right-tilted frame",
      "distance": "extended arm’s length, device fully out of frame",
      "framing_rule": "subject positioned lower-left in frame to prevent top-edge hand intrusion",
      "lens_feel": "natural iPhone perspective, no wide-angle distortion",
      "composition_bias": "intentional right-leaning diagonal composition, not level or symmetrical"
    },
    "lighting": {
      "primary": "bright indoor kitchen lighting with soft even fill",
      "secondary": "subtle warm practicals adding depth",
      "contrast": "moderate, preserving facial structure and skin texture",
      "bokeh": "none"
    }
  },
  "selfie_realism_rule": "high-angle selfie must be achieved by forward-and-side camera placement, not overhead reach; keep hand and forearm completely out of frame while maintaining the right-tilted angle",
  "realism": {
    "detail_level": "high-fidelity photographic realism",
    "constraints": [
      "no AI artifacts",
      "no over-stylization",
      "no loss of texture",
      "no artificial bokeh",
      "no cinematic grading"
    ]
  },
  "aspect_ratio": "4:5"
};

// --- 2. YOUR ROTATION LISTS ---
const environments = [
    "Modern kitchen", "Home gym", "Commercial gym", "Bedroom", 
    "Bathroom mirror", "Living room", "Home office / desk", "Library", 
    "Cafe", "Office", "Car interior", "City street", 
    "Park / outdoors", "Rooftop", "Beach", "Hotel room", 
    "Closet / mirror", "Locker room"
];

const poses = [
    "POV front-facing selfie", "Mirror selfie in gym", "Bathroom mirror selfie", 
    "Gym workout selfie", "Post-workout selfie", "Full-body mirror outfit check", 
    "Getting ready", "Coffee in hand", "Sitting on kitchen counter", 
    "Lounging on bed", "Studying at a desk", "Deep focus on laptop", 
    "Journaling in a notebook", "Meditating calmly", "Reading a book", 
    "Morning routine", "Planning the day / to-do list", "After a cold shower", 
    "Stretching / yoga", "Making the bed", "Drinking water", 
    "Walking outdoors", "Cooking a healthy meal", "Throwing cigarettes in the trash", 
    "Snapping a cigarette in half", "Pouring out alcohol", "Throwing away a vape", 
    "Holding phone showing an app blocker", "Checking a streak on phone", 
    "Resisting a craving, hand raised", "Motivated after a workout", 
    "Fresh and focused, no phone", "Calm and in control, empty hands"
];

// --- 3. HELPER FUNCTIONS ---
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Find Slate editor instance and set text directly in Slate's document model
function setSlateTextDirectly(element, text) {
    const reactKey = Object.keys(element).find(key => 
        key.startsWith('__reactProps$') || 
        key.startsWith('__reactEvents$') ||
        key.startsWith('__reactInternalInstance$') ||
        key.startsWith('__reactFiber$')
    );
    if (!reactKey) return false;
    
    let fiber = element[reactKey];
    while (fiber) {
        const editor = (fiber.memoizedProps && fiber.memoizedProps.editor) || 
                       (fiber.stateNode && fiber.stateNode.props && fiber.stateNode.props.editor);
        if (editor && typeof editor.insertText === 'function') {
            console.log("Found Slate editor object. Modifying Slate document...");
            
            // Focus
            editor.focus?.();
            
            // Clear current content by selecting everything and deleting
            editor.selection = {
                anchor: { path: [0, 0], offset: 0 },
                focus: { path: [editor.children.length - 1, 0], offset: 0 }
            };
            
            // Delete selection
            if (typeof editor.deleteBackward === 'function') {
                editor.deleteBackward('character');
            }
            
            // Insert text
            editor.insertText(text);
            
            // Trigger React rendering
            editor.onChange?.();
            return true;
        }
        fiber = fiber.return;
    }
    return false;
}

// Trick Slate.js by simulating a real human pasting text
function setInputText(inputElement, text) {
    inputElement.focus();
    
    // Clear existing content for DOM fallbacks
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    
    // 1. Try paste event first (highly supported by React/Slate event listeners, updates parent React state)
    let pasted = false;
    try {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('text/plain', text);
        const pasteEvent = new ClipboardEvent('paste', {
            clipboardData: dataTransfer,
            bubbles: true,
            cancelable: true
        });
        inputElement.dispatchEvent(pasteEvent);
        pasted = true;
    } catch (e) {
        console.warn("Paste event simulation failed:", e);
    }
    
    // Check if paste was handled and text was inserted
    if (inputElement.textContent.trim() === text.trim()) {
        console.log("✅ Text inserted successfully via paste event.");
        return;
    }
    
    // 2. Try beforeinput event
    try {
        const beforeInput = new InputEvent('beforeinput', {
            inputType: 'insertText',
            data: text,
            bubbles: true,
            cancelable: true
        });
        inputElement.dispatchEvent(beforeInput);
    } catch (e) {
        console.warn("beforeinput event failed:", e);
    }
    
    // Check if beforeinput was handled and text was inserted
    if (inputElement.textContent.trim() === text.trim()) {
        console.log("✅ Text inserted successfully via beforeinput event.");
        return;
    }

    // 3. Fallback: execCommand insertText
    console.log("Using fallback execCommand insertText...");
    document.execCommand('insertText', false, text);
    
    // Check if fallback worked
    if (inputElement.textContent.trim() === text.trim()) {
        console.log("✅ Text inserted successfully via execCommand.");
    } else {
        // 4. Try direct Slate.js editor instance modification as absolute last resort
        try {
            const success = setSlateTextDirectly(inputElement, text);
            if (success) {
                console.log("✅ Text inserted directly via Slate.js editor instance.");
                return;
            }
        } catch (e) {
            console.warn("Direct Slate.js injection failed:", e);
        }
    }
    
    // Trigger update events
    inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    inputElement.dispatchEvent(new Event('change', { bubbles: true }));
}

// Create a mock React event wrapped around a real MouseEvent with nativeEvent self-reference
function createReactMockEvent(type, target, currentTarget, extra = {}) {
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    
    const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        ...extra
    });
    
    // Self-reference nativeEvent so React doesn't crash on event.nativeEvent.something
    Object.defineProperty(event, 'nativeEvent', {
        value: event,
        writable: true,
        configurable: true
    });
    
    Object.defineProperty(event, 'target', { value: target, configurable: true });
    Object.defineProperty(event, 'currentTarget', { value: currentTarget, configurable: true });
    
    return event;
}

// Create a mock React pointer event wrapped around a real PointerEvent
function createReactPointerMockEvent(type, target, currentTarget, extra = {}) {
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    
    const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        ...extra
    });
    
    Object.defineProperty(event, 'nativeEvent', {
        value: event,
        writable: true,
        configurable: true
    });
    
    Object.defineProperty(event, 'target', { value: target, configurable: true });
    Object.defineProperty(event, 'currentTarget', { value: currentTarget, configurable: true });
    
    return event;
}

// Fire a robust, React-friendly click
function simulateReactClick(element) {
    if (!element) return;
    
    // Helper to dispatch full suite of click events on a specific target
    const dispatchClickEvents = (target) => {
        target.focus?.();
        
        // Pointer events
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
        
        // Mouse events
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        
        // Click events
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        target.click?.();
    };

    // Dispatch on the button itself
    dispatchClickEvents(element);

    // Also dispatch on the icon/span child inside (e.g. <i>arrow_forward</i>), 
    // as React event handlers sometimes check e.target for child elements.
    const inner = element.querySelector('i, span, svg');
    if (inner) {
        dispatchClickEvents(inner);
    }
}

async function addCharacterReference() {
    console.log("Adding character reference...");
    
    const plusBtn = Array.from(document.querySelectorAll('button')).find(btn => 
        btn.innerHTML.includes('add_2')
    );
    if(plusBtn) simulateReactClick(plusBtn);
    else { console.error("❌ Could not find '+' button."); return; }
    await sleep(1000); 

    const targetCharacter = Array.from(document.querySelectorAll('[role="option"]')).find(el => 
        el.textContent.includes('Untitled Character')
    );
    if(targetCharacter) simulateReactClick(targetCharacter);
    else { console.error("❌ Could not find 'Untitled Character'."); return; }
    await sleep(500);

    const addBtn = Array.from(document.querySelectorAll('button')).find(el => 
        el.textContent.includes('Add to Prompt')
    );
    if(addBtn) simulateReactClick(addBtn);
    await sleep(1000); 
}

// --- 4. THE AUTOMATION LOOP ---
async function startAutomation() {
    console.log("🚀 Starting automation loop...");

    for (let env of environments) {
        for (let pose of poses) {
            console.log(`\n🤖 Generating: ${env} + ${pose}`);

            // A. Add Character
            await addCharacterReference();

            // B. Update the prompt object
            let currentPrompt = JSON.parse(JSON.stringify(basePrompt)); 
            currentPrompt.environment.location = env;
            currentPrompt.pose_and_expression.pose = pose;
            const promptString = JSON.stringify(currentPrompt, null, 2);

            // C. Paste the prompt (using the Slate.js compatible selector)
            let inputBox = document.querySelector('[data-slate-editor="true"]') || document.querySelector('[contenteditable="true"]');
            
            if (inputBox) {
                setInputText(inputBox, promptString);
            } else {
                console.error("❌ Could not find input box.");
                return; 
            }
            
            // D. Wait smartly for the Generate button to become active
            let generateBtn = null;
            let attempts = 0;
            console.log("⏳ Waiting for Generate button to activate...");
            
            // Try every 500ms for up to 5 seconds
            while (attempts < 10) { 
                generateBtn = Array.from(document.querySelectorAll('button')).find(btn => 
                    btn.innerHTML.includes('arrow_forward') && 
                    btn.textContent.includes('Create') &&
                    btn.getAttribute('aria-disabled') !== 'true' && 
                    !btn.disabled
                );
                
                if (generateBtn) break; // Button found and is active!
                await sleep(500);
                attempts++;
            }

            // E. Click Generate
            if (generateBtn) {
                console.log("👉 Clicking Generate...");
                
                // 0. Try keyboard submit shortcuts (Ctrl+Enter and Cmd+Enter) on the input box
                try {
                    console.log("Keyboard shortcut submission attempt on input box...");
                    const enterOptions = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
                    inputBox.dispatchEvent(new KeyboardEvent('keydown', { ...enterOptions, ctrlKey: true }));
                    inputBox.dispatchEvent(new KeyboardEvent('keydown', { ...enterOptions, metaKey: true }));
                } catch (err) {
                    console.warn("Keyboard shortcut dispatch failed:", err);
                }

                // Get precise coordinates of the button center
                const rect = generateBtn.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                
                const eventOptions = {
                    clientX: x,
                    clientY: y,
                    screenX: x,
                    screenY: y,
                    bubbles: true,
                    cancelable: true,
                    view: window
                };

                // Focus the element first
                generateBtn.focus();
                
                // 1. Dispatch coordinate-based Pointer events
                generateBtn.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
                generateBtn.dispatchEvent(new PointerEvent('pointerup', eventOptions));
                
                // 2. Dispatch coordinate-based Mouse events
                generateBtn.dispatchEvent(new MouseEvent('mousedown', eventOptions));
                generateBtn.dispatchEvent(new MouseEvent('mouseup', eventOptions));
                
                // 3. Dispatch coordinate-based Click event
                generateBtn.dispatchEvent(new MouseEvent('click', eventOptions));
                
                // 4. Trigger standard click method
                generateBtn.click();
                
                // 5. Target the inner <i> icon child specifically with coordinates
                const icon = generateBtn.querySelector('i');
                if (icon) {
                    const iconRect = icon.getBoundingClientRect();
                    const ix = iconRect.left + iconRect.width / 2;
                    const iy = iconRect.top + iconRect.height / 2;
                    const iconEventOptions = {
                        clientX: ix,
                        clientY: iy,
                        screenX: ix,
                        screenY: iy,
                        bubbles: true,
                        cancelable: true,
                        view: window
                    };
                    icon.dispatchEvent(new PointerEvent('pointerdown', iconEventOptions));
                    icon.dispatchEvent(new PointerEvent('pointerup', iconEventOptions));
                    icon.dispatchEvent(new MouseEvent('mousedown', iconEventOptions));
                    icon.dispatchEvent(new MouseEvent('mouseup', iconEventOptions));
                    icon.dispatchEvent(new MouseEvent('click', iconEventOptions));
                    icon.click();
                }

                // 6. Directly invoke React's internal handler functions on the button and its ancestors (bypasses event.isTrusted)
                // We do NOT break early; we bubble the event up the full chain so all listeners on the path run.
                try {
                    let current = generateBtn;
                    while (current && current.tagName !== 'BODY' && current.tagName !== 'HTML') {
                        const reactKey = Object.keys(current).find(key => 
                            key.startsWith('__reactProps$') || 
                            key.startsWith('__reactEvents$') || 
                            key.startsWith('__reactInternalInstance$') ||
                            key.startsWith('__reactFiber$')
                        );
                        if (reactKey) {
                            const node = current[reactKey];
                            const props = node.memoizedProps || node;
                            if (props) {
                                if (typeof props.onClick === 'function') {
                                    console.log("Directly invoked React onClick on:", current.tagName);
                                    const event = createReactMockEvent('click', generateBtn, current);
                                    props.onClick(event);
                                }
                                if (typeof props.onMouseDown === 'function') {
                                    console.log("Directly invoked React onMouseDown on:", current.tagName);
                                    const event = createReactMockEvent('mousedown', generateBtn, current);
                                    props.onMouseDown(event);
                                }
                                if (typeof props.onPointerDown === 'function') {
                                    console.log("Directly invoked React onPointerDown on:", current.tagName);
                                    const event = createReactPointerMockEvent('pointerdown', generateBtn, current);
                                    props.onPointerDown(event);
                                }
                            }
                        }
                        current = current.parentElement;
                    }
                } catch (err) {
                    console.error("Direct React handler invocation failed:", err);
                }

                // 7. Submit the parent form if there is one, including React's onSubmit
                const form = generateBtn.closest('form');
                if (form) {
                    try {
                        const reactKey = Object.keys(form).find(key => 
                            key.startsWith('__reactProps$') || 
                            key.startsWith('__reactEvents$') || 
                            key.startsWith('__reactInternalInstance$') ||
                            key.startsWith('__reactFiber$')
                        );
                        if (reactKey) {
                            const node = form[reactKey];
                            const props = node.memoizedProps || node;
                            if (props && typeof props.onSubmit === 'function') {
                                console.log("Directly invoked React onSubmit on form");
                                const event = new Event('submit', { bubbles: true, cancelable: true });
                                Object.defineProperty(event, 'nativeEvent', { value: event, configurable: true });
                                Object.defineProperty(event, 'target', { value: form, configurable: true });
                                Object.defineProperty(event, 'currentTarget', { value: form, configurable: true });
                                props.onSubmit(event);
                            }
                        }
                    } catch (err) {
                        console.error("Direct React form submission failed:", err);
                    }
                    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                }
            } else {
                console.error("❌ Could not find an active generate button. It might still be disabled.");
                return;
            }

            // F. Wait for generation to complete
            const waitTime = 60000; // 60 seconds (increase if generations take longer)
            console.log(`⏱️ Waiting ${waitTime / 1000}s for generation...`);
            await sleep(waitTime);
        }
    }
    console.log("🏁 All complete!");
}

startAutomation();