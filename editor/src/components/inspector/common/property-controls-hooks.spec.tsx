import React from 'react'
import { renderHook } from '@testing-library/react-hooks'
import { EditorStateContext } from '../../editor/store/store-hook'
import { useGetPropertyControlsForSelectedComponents } from './property-controls-hooks'
import { InspectorCallbackContext, InspectorCallbackContextData } from './property-path-hooks'
import create from 'zustand'
import {
  editorModelFromPersistentModel,
  EditorState,
  EditorStorePatched,
} from '../../editor/store/editor-state'
import { NO_OP } from '../../../core/shared/utils'
import * as EP from '../../../core/shared/element-path'
import { ElementPath } from '../../../core/shared/project-file-types'
import { createTestProjectWithCode } from '../../../sample-projects/sample-project-utils.test-utils'
import { TestAppUID, TestSceneUID } from '../../canvas/ui-jsx.test-utils'
import { BakedInStoryboardUID } from '../../../core/model/scene-utils'
import {
  elementInstanceMetadata,
  ElementInstanceMetadataMap,
  jsxElementWithoutUID,
} from '../../../core/shared/element-template'
import { PropertyControls } from 'utopia-api/core'

const TestAppUID2 = 'app-entity-2'
const TestOtherComponentUID = 'other-component-entity-1'

const propertyControlsForApp: PropertyControls = {
  propWithControlButNoValue: {
    control: 'string-input',
    label: 'No Value',
  },
}

const propertyControlsForOtherComponent: PropertyControls = {
  propWithOtherKey: {
    control: 'number-input',
    label: 'Katz',
  },
}

function callPropertyControlsHook(selectedViews: ElementPath[]) {
  const persistentModel = createTestProjectWithCode(`
  import * as React from 'react'
  import {
    View,
    Scene,
    Storyboard,
  } from 'utopia-api'
  export var App = (props) => {
    const propToDetect = props.testDetectedPropertyWithNoValue
    return (
      <div data-uid={'aaa'}/>
    )
  }
  // Note: for this test, we are not running the property controls parser. Otherwise this is where App.propertyControls would come

  export var OtherComponent = (props) => {
    return (
      <div data-uid={'aaa'}/>
    )
  }
  // Note: for this test, we are not running the property controls parser. Otherwise this is where App.propertyControls would come
 

  export var storyboard = (props) => {
    return (
      <Storyboard data-uid={'${BakedInStoryboardUID}'}>
        <Scene
          style={{ position: 'relative', left: 0, top: 0, width: 375, height: 812 }}
          data-uid={'${TestSceneUID}'}
        >
          <App
            data-uid='${TestAppUID}' 
            style={{ position: 'absolute', bottom: 0, left: 0, right: 0, top: 0 }}
            testPropWithoutControl='yes'
          />
          <App
            data-uid='${TestAppUID2}' 
            style={{ position: 'absolute', bottom: 0, left: 0, right: 0, top: 0 }}
            propWithControlButNoValue='but there is a value!'
          />
          <OtherComponent
            data-uid='${TestOtherComponentUID}' 
            style={{ position: 'absolute', bottom: 0, left: 0, right: 0, top: 0 }}
            propWithOtherKey={10}
          />
        </Scene>
      </Storyboard>
    )
  }
  `)

  // We manually have to create these ElementInstanceMetadatas because we are not running the canvas/spy/dom-walker for this test
  let metadata: ElementInstanceMetadataMap = {
    [EP.toString(selectedViews[0])]: elementInstanceMetadata(
      selectedViews[0],
      null as any,
      { testPropWithoutControl: 'yes' },
      null,
      null,
      true,
      false,
      null as any,
      null,
      null,
      null,
      null,
    ),
  }

  if (selectedViews.length > 1) {
    metadata[EP.toString(selectedViews[1])] = elementInstanceMetadata(
      selectedViews[1],
      null as any,
      { propWithControlButNoValue: 'but there is a value!' },
      null,
      null,
      true,
      false,
      null as any,
      null,
      null,
      null,
      null,
    )
  }
  if (selectedViews.length > 2) {
    metadata[EP.toString(selectedViews[2])] = elementInstanceMetadata(
      selectedViews[1],
      null as any,
      { propWithOtherKey: 10 },
      null,
      null,
      true,
      false,
      null as any,
      null,
      null,
      null,
      null,
    )
  }

  const initialEditorState = editorModelFromPersistentModel(persistentModel, NO_OP)
  const editorState: EditorState = {
    ...initialEditorState,
    selectedViews: selectedViews,
    propertyControlsInfo: {
      ...initialEditorState.propertyControlsInfo,
      '/utopia/storyboard': {
        App: {
          properties: propertyControlsForApp,
          variants: [
            {
              insertMenuLabel: 'App',
              importsToAdd: {},
              elementToInsert: jsxElementWithoutUID('App', [], []),
            },
          ],
        },
        OtherComponent: {
          properties: propertyControlsForOtherComponent,
          variants: [
            {
              insertMenuLabel: 'OtherComponent',
              importsToAdd: {},
              elementToInsert: jsxElementWithoutUID('OtherComponent', [], []),
            },
          ],
        },
      },
    },
    jsxMetadata: metadata,
  }

  const initialEditorStore: EditorStorePatched = {
    editor: editorState,
    derived: null as any,
    strategyState: null as any,
    history: null as any,
    userState: null as any,
    workers: null as any,
    persistence: null as any,
    dispatch: null as any,
    alreadySaved: null as any,
    builtInDependencies: [],
  }

  const storeHook = create<EditorStorePatched>((set) => initialEditorStore)

  const inspectorCallbackContext: InspectorCallbackContextData = {
    selectedViewsRef: { current: selectedViews },
    onSubmitValue: null as any,
    onUnsetValue: null as any,
  }

  const contextProvider = ({ children }: any) => (
    <EditorStateContext.Provider value={{ useStore: storeHook, api: storeHook }}>
      <InspectorCallbackContext.Provider value={inspectorCallbackContext}>
        {children}
      </InspectorCallbackContext.Provider>
    </EditorStateContext.Provider>
  )

  const { result } = renderHook(() => useGetPropertyControlsForSelectedComponents(), {
    wrapper: contextProvider,
  })
  return { result: result.current, getEditorState: () => storeHook.getState() }
}

describe('useGetPropertyControlsForSelectedComponents', () => {
  it('single select', () => {
    const selectedViews = [EP.elementPath([[BakedInStoryboardUID, TestSceneUID, TestAppUID]])]
    const { result } = callPropertyControlsHook(selectedViews)

    expect(result.length).toBe(1)

    expect(result[0].controls).toEqual(propertyControlsForApp)
    expect(result[0].detectedPropsAndValuesWithoutControls).toEqual({
      testPropWithoutControl: 'yes',
    })
    expect(result[0].detectedPropsWithNoValue).toEqual(['testDetectedPropertyWithNoValue'])
    expect(result[0].propsWithControlsButNoValue).toEqual(['propWithControlButNoValue'])
    expect(result[0].targets).toEqual(selectedViews)
  })

  it('multiselect', () => {
    const selectedViews = [
      EP.elementPath([[BakedInStoryboardUID, TestSceneUID, TestAppUID]]),
      EP.elementPath([[BakedInStoryboardUID, TestSceneUID, TestAppUID2]]),
    ]
    const { result } = callPropertyControlsHook(selectedViews)

    expect(result.length).toBe(1)

    expect(result[0].controls).toEqual(propertyControlsForApp)
    expect(result[0].detectedPropsAndValuesWithoutControls).toEqual({
      testPropWithoutControl: 'yes',
    })
    expect(result[0].detectedPropsWithNoValue).toEqual(['testDetectedPropertyWithNoValue'])
    expect(result[0].propsWithControlsButNoValue).toEqual([])
    expect(result[0].targets).toEqual(selectedViews)
  })

  it('TODO: a test with multiselect of different components', () => {
    const selectedViews = [
      EP.elementPath([[BakedInStoryboardUID, TestSceneUID, TestAppUID]]),
      EP.elementPath([[BakedInStoryboardUID, TestSceneUID, TestAppUID2]]),
      EP.elementPath([[BakedInStoryboardUID, TestSceneUID, TestOtherComponentUID]]),
    ]
    const { result } = callPropertyControlsHook(selectedViews)

    expect(result.length).toBe(2)

    expect(result[0].controls).toEqual(propertyControlsForApp)
    expect(result[0].detectedPropsAndValuesWithoutControls).toEqual({
      testPropWithoutControl: 'yes',
    })
    expect(result[0].detectedPropsWithNoValue).toEqual(['testDetectedPropertyWithNoValue'])
    expect(result[0].propsWithControlsButNoValue).toEqual([])
    expect(result[0].targets).toEqual([
      EP.elementPath([[BakedInStoryboardUID, TestSceneUID, TestAppUID]]),
      EP.elementPath([[BakedInStoryboardUID, TestSceneUID, TestAppUID2]]),
    ])

    expect(result[1].targets).toEqual([
      EP.elementPath([[BakedInStoryboardUID, TestSceneUID, TestOtherComponentUID]]),
    ])

    expect(result[1].controls).toEqual(propertyControlsForOtherComponent)
    expect(result[1].detectedPropsAndValuesWithoutControls).toEqual({})
    expect(result[1].detectedPropsWithNoValue).toEqual([])
    expect(result[1].propsWithControlsButNoValue).toEqual([])
  })
})
